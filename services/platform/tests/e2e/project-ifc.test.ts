import { storeFilePlacementCredential } from "../../src/provider-workflows/file-context-credential";
import {
  fixtureDatabase,
  onboardFixtureOrganisation,
} from "./organisation-database";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import {
  newProjectId,
  newConversationId,
  newUserId,
  type ConversationId,
  type UserId,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import {
  issueControlSession,
  readActiveOrganisationMembershipRevision,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import { parseVaultHandle, storeVaultSecret } from "../../src/credential-vault";
import {
  compileTurnAuthority,
  CONTEXT_CASE_READ_CAPABILITY,
} from "../../src/authorization/access-grants/turn-authority";
import { encodeContextVisibility } from "../../src/authorization/access-grants/visibility";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { buildControlAuthority } from "../../src/request-authority";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import { deriveDirectCaseIdentities } from "../../src/actors/case-direct-processing";
import { readSessionInformationFlow } from "../../src/actors/agent-session-information-flow";
import { audiencesForAdmission } from "../../src/policy/information-flow";
import {
  applyFileProjectionCommand,
  createFileProjectionCommand,
  replaceFileGrantAdmissions,
} from "../../src/context/files";
import { ProviderFileProjectionSourceReader } from "../../src/context/files/provider-source";
import { upsertFileResourceSource } from "../../src/context/files/persistence";
import {
  readGrantedFile,
  type FileToolObservation,
  type CanonicalFileReference,
} from "../../src/context/files/tools";
import { parseSessionId, type OrganisationId } from "../../src/ids";
import { readConversation, saveConversation } from "../../src/chat/store";
import { observeProjectReference } from "../../src/projects/references";
import { platformConversation } from "./chat-journey-support";
import { commerceClient } from "./commerce-support";
import {
  createRequiredGrant,
  installSlackActorFixture,
  openRouterText,
  ORGANISATION_ID,
} from "./slack-journey-support";
import { network } from "./network";
import { revokeAccessGrant } from "../../src/data/access-grants";
import { PLATFORM_DEFAULT_PI_MODEL } from "../../src/actors/pi-model-transport";

const SOURCE_NAME = "Restricted P54B supplier.pdf";
const SOURCE_ID = "id:p54b-supplier";
const SOURCE_REVISION = "p54b-revision-1";
const BRIEF = "P54B project brief: reserve the violet delivery window.";
const BASE = `/v1/control/organisations/${ORGANISATION_ID}/chat`;
const PROJECTS = `/v1/control/organisations/${ORGANISATION_ID}/projects`;

type Member = Readonly<{
  userId: UserId;
  personId: string;
  session: IssuedControlSession;
}>;
type ResponseGate =
  | Readonly<{ kind: "immediate" }>
  | Readonly<{
      kind: "held";
      resume: PromiseWithResolvers<void>;
    }>;
type Provider = {
  prompts: string[];
  metadataReads: number;
  bodyReads: number;
  gate: ResponseGate;
};

it(
  "enforces source metadata grants and carries project observations through accepted history and Actor eviction",
  projectInformationFlowJourney.bind(null, "Orchard logistics"),
  70000,
);

it(
  "preserves source restrictions when automatic retrieval also admits referenced metadata",
  projectInformationFlowJourney.bind(null, "Restricted P54B supplier"),
  70000,
);

async function projectInformationFlowJourney(
  conversationTitle: string,
  context: TestContext,
): Promise<void> {
  // The Slack fixture makes the one account attach of the Organisation; it
  // admits the four people of this journey before they get their roles.
  const people = [
    await person("Owner"),
    await person("Editor"),
    await person("Viewer"),
    await person("Unrelated member"),
  ] as const;
  await installSlackActorFixture();
  const owner = await joinOrganisation(people[0]);
  const editor = await joinOrganisation(people[1]);
  const viewer = await joinOrganisation(people[2]);
  const outsider = await joinOrganisation(people[3]);
  const foreignOrganisation = await onboardFixtureOrganisation(
    "Foreign IFC organisation",
  );
  const foreign = await member(
    foreignOrganisation.organisationId,
    "Foreign member",
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_p54b', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const provider: Provider = {
    prompts: [],
    metadataReads: 0,
    bodyReads: 0,
    gate: { kind: "immediate" },
  };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      reply.bind(null, provider),
    ),
    http.post("https://api.dropboxapi.com/oauth2/token", refreshToken),
    http.post(
      "https://api.dropboxapi.com/2/users/get_current_account",
      dropboxAccount,
    ),
    http.post(
      "https://api.dropboxapi.com/2/files/get_metadata",
      dropboxMetadata.bind(null, provider),
    ),
    http.post(
      "https://content.dropboxapi.com/2/files/download",
      unexpectedBody.bind(null, provider),
    ),
  );
  const reference = await source(owner);
  for (const user of [owner, editor, viewer]) {
    await createRequiredGrant({
      grantId: `history_${user.userId}`,
      subject: { kind: "person", personId: user.personId },
      target: {
        kind: "platform_capability",
        capabilityId: CONTEXT_CASE_READ_CAPABILITY,
        capabilityVersion: 1,
      },
      now: Date.now(),
    });
  }
  // A different resource grant distinguishes source permission from organisation role.
  await createRequiredGrant({
    grantId: `other_file_${editor.userId}`,
    subject: { kind: "person", personId: editor.personId },
    target: {
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: reference.integrationAccountId,
      scope: {
        kind: "dropbox_file",
        providerFileId: "id:other-p54b-file",
        pathDisplay: "/Other.pdf",
      },
    },
    now: Date.now(),
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  await projectSource(owner, reference);
  const ownerObservations: FileToolObservation[] = [];
  expect(
    await protectedMetadata(
      owner,
      reference,
      policy.value.snapshot.version,
      ownerObservations,
    ),
  ).toMatchObject({ kind: "metadata_only", title: SOURCE_NAME });
  expect(ownerObservations).toHaveLength(1);
  const editorObservations: FileToolObservation[] = [];
  await expect(
    protectedMetadata(
      editor,
      reference,
      policy.value.snapshot.version,
      editorObservations,
    ),
  ).rejects.toThrow("file_read_not_authorized");
  expect(editorObservations).toHaveLength(0);
  expect(provider.metadataReads).toBeGreaterThan(0);
  expect(provider.bodyReads).toBe(0);

  const ownerSearch = await get(
    owner,
    `${PROJECTS}/references?search=restricted`,
  );
  expect(ownerSearch).toMatchObject({
    references: [expect.objectContaining({ label: SOURCE_NAME })],
  });
  const searches = [];
  for (const user of [editor, viewer, outsider, foreign]) {
    const response = await request(
      user,
      `${PROJECTS}/references?search=restricted`,
      null,
    );
    const body = await response.text();
    searches.push({
      userId: user.userId,
      status: response.status,
      exposesSourceTitle: body.includes(SOURCE_NAME),
    });
    expect
      .soft(body, "Source metadata must be hidden without the exact file grant")
      .not.toContain(SOURCE_NAME);
  }
  const submittedReference = {
    kind: "file" as const,
    ...reference,
    label: "Untrusted submitted title",
  };
  const unauthorizedObservation = await observeProjectReference(
    env,
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    { organisationId: ORGANISATION_ID, userId: editor.userId },
    submittedReference,
    Date.now(),
  );
  expect
    .soft(
      unauthorizedObservation.kind,
      "Availability cannot establish metadata admission",
    )
    .toBe("unavailable");
  const canonicalObservation = await observeProjectReference(
    env,
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    { organisationId: ORGANISATION_ID, userId: owner.userId },
    submittedReference,
    Date.now(),
  );
  expect
    .soft(
      canonicalObservation.reference.label,
      "Source adapter must resolve the canonical title",
    )
    .toBe(SOURCE_NAME);

  const projectId = newProjectId();
  expect(
    (
      await request(owner, PROJECTS, {
        kind: "create_project",
        operationId: crypto.randomUUID(),
        projectId,
        content: {
          name: "P54B source project",
          brief: BRIEF,
          references: [{ kind: "file", ...reference, label: SOURCE_NAME }],
        },
      })
    ).status,
  ).toBe(200);
  const conversationId = newConversationId();
  expect(
    (
      await saveConversation(
        await requireOrganisationExecutionScope(env, ORGANISATION_ID),
        owner.userId,
        platformConversation(
          conversationId,
          conversationTitle,
          PLATFORM_DEFAULT_PI_MODEL,
        ),
        0,
        { projectId },
      )
    ).kind,
  ).toBe("saved");
  const started = await request(owner, BASE, {
    kind: "message",
    conversationId,
    requestId: "p54b_initial",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Acknowledge the inherited project context without searching or reading files.",
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 25000 })
    .toBe("ready");
  expect(provider.prompts.join("\n")).toContain(BRIEF);
  expect(provider.prompts.join("\n")).toContain(SOURCE_NAME);
  const stored = await readConversation(
    fixtureDatabase(),
    { organisationId: ORGANISATION_ID, userId: owner.userId },
    conversationId,
  );
  const history = stored?.conversation.historyBindings.at(-1);
  if (stored === null || history === undefined)
    throw new Error("Accepted history missing");
  const sessionId = parseSessionId(history.sessionId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const actor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!actor.ok) throw new Error(actor.error.code);
  const before = await runInDurableObject(
    actor.value,
    inspectFlow.bind(null, sessionId.value),
  );
  expect
    .soft(
      before.observations,
      "Model-visible reference metadata needs source-owned observation evidence",
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: {
            kind: "integration_resource",
            organisationId: ORGANISATION_ID,
            integrationAccountId: reference.integrationAccountId,
            resourceScope: `dropbox_file:${SOURCE_ID}`,
          },
        }),
      ]),
    );
  expect
    .soft(
      before.observations,
      "Model-visible brief needs its exact native project observation",
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({
            organisationId: ORGANISATION_ID,
            projectId,
          }),
          sourceRevision: 1,
        }),
      ]),
    );
  await evictDurableObject(actor.value);
  const restored = await runInDurableObject(
    actor.value,
    inspectFlow.bind(null, sessionId.value),
  );
  expect(restored).toEqual(before);

  const share = await request(owner, `${PROJECTS}/${projectId}/access`, {
    kind: "share_project",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 0,
    members: [
      { userId: editor.userId, role: "editor" },
      { userId: viewer.userId, role: "viewer" },
    ],
  });
  const shareBody: unknown = await share.json();
  expect
    .soft(
      shareBody,
      "A prospective member's unrelated file grant cannot authorize restricted project metadata",
    )
    .toMatchObject({ kind: "rejected" });
  const peerDirectory = await get(editor, `${BASE}/projects`);
  expect
    .soft(
      JSON.stringify(peerDirectory),
      "Denied member admission must leave metadata inaccessible",
    )
    .not.toContain(SOURCE_NAME);
  const shareConversation = await request(
    owner,
    `${BASE}/conversations/${conversationId}/access`,
    {
      kind: "share_conversation",
      operationId: crypto.randomUUID(),
      expectedRevision: stored.revision,
      projectId,
      expectedProjectAccessRevision: 1,
    },
  );
  const disclosure: unknown = await shareConversation.json();
  expect
    .soft(disclosure, "Source restrictions must constrain history sharing")
    .toMatchObject({ kind: "rejected" });
  const peerReplay = await get(
    editor,
    `${BASE}?conversation=${conversationId}&observe=true`,
  );
  expect
    .soft(
      peerReplay.conversation,
      "A denied audience cannot replay the source-bearing conversation",
    )
    .toBeNull();
  const held: Extract<ResponseGate, { kind: "held" }> = {
    kind: "held",
    resume: Promise.withResolvers(),
  };
  provider.gate = held;
  const pending = await request(owner, BASE, {
    kind: "message",
    conversationId,
    requestId: "p54b_revoke_during_response",
    model: PLATFORM_DEFAULT_PI_MODEL,
    text: "Check the retained context once more.",
    browserContext: { kind: "unavailable" },
  });
  expect(pending.status).toBe(200);
  await pending.text();
  await expect.poll(modelCalls.bind(null, provider)).toBe(2);
  const subscription = await request(
    owner,
    `${BASE}/stream?conversation=${conversationId}&request=p54b_revoke_during_response`,
    null,
  );
  expect(subscription.status).toBe(200);
  const pendingContent = subscription.text();
  let revokedReplayStatus = 0;
  try {
    const revoked = await revokeAccessGrant({
      db: fixtureDatabase(),
      organisationId: ORGANISATION_ID,
      grantId: "grant_p54b_source",
      expectedRevision: 1,
      reason: "P54B publication race",
      now: Date.now(),
    });
    expect(revoked.ok).toBe(true);
    const revokedReplay = await request(
      owner,
      `${BASE}?conversation=${conversationId}&observe=true`,
      null,
    );
    expect(revokedReplay.status).toBe(403);
    expect(await revokedReplay.json()).toMatchObject({
      code: "chat_history_forbidden",
      reason: "source_policy_denied",
    });
    revokedReplayStatus = revokedReplay.status;
  } finally {
    held.resume.resolve();
    expect(await pendingContent).not.toContain(
      "Project context acknowledged 2.",
    );
  }
  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 25000 })
    .toBe("failed");
  expect(
    (
      await readConversation(
        fixtureDatabase(),
        { organisationId: ORGANISATION_ID, userId: owner.userId },
        conversationId,
      )
    )?.conversation.completedRequests,
  ).not.toContain("p54b_revoke_during_response");
  const unavailableAfterRevocation = await observeProjectReference(
    env,
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    { organisationId: ORGANISATION_ID, userId: owner.userId },
    submittedReference,
    Date.now(),
  );
  expect(unavailableAfterRevocation.kind).toBe("unavailable");
  expect(JSON.stringify(unavailableAfterRevocation)).not.toContain(SOURCE_NAME);
  const revokedSearch = await get(
    owner,
    `${PROJECTS}/references?search=restricted`,
  );
  expect(JSON.stringify(revokedSearch)).not.toContain(SOURCE_NAME);
  await expect(
    protectedMetadata(owner, reference, policy.value.snapshot.version, []),
  ).rejects.toThrow("file_read_not_authorized");
  Object.assign(context.task.meta, {
    plan54B: {
      scenario: "metadata-and-project-admission",
      conversationTitle,
      source: {
        name: SOURCE_NAME,
        providerRevision: SOURCE_REVISION,
        grantRevision: 1,
        policyVersion: policy.value.snapshot.version,
        metadataReads: provider.metadataReads,
        bodyReads: provider.bodyReads,
        adapterObservations: ownerObservations.map(serializeObservation),
      },
      searches,
      unauthorizedObservation,
      canonicalObservation,
      projectId,
      projectContentRevision: 1,
      share: shareBody,
      disclosure,
      peerReplayVisible: peerReplay.conversation !== null,
      revokedSource: {
        deniedMetadata: unavailableAfterRevocation.kind,
        replayStatus: revokedReplayStatus,
        heldResponseWithheld: true,
      },
      acceptedHistory: { sessionId: history.sessionId, turnId: history.turnId },
      beforeEviction: before,
      afterEviction: restored,
      promptContainsBrief: provider.prompts.join("\n").includes(BRIEF),
      promptContainsMetadata: provider.prompts.join("\n").includes(SOURCE_NAME),
    },
  });
}

async function person(name: string) {
  const client = await commerceClient(`p54b-${crypto.randomUUID()}`);
  const personId = `person_${crypto.randomUUID()}`;
  return { name, client, personId, slot: { client, laterPersonId: personId } };
}

async function joinOrganisation(
  joining: Awaited<ReturnType<typeof person>>,
): Promise<Member> {
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(ORGANISATION_ID, joining.personId, joining.name),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      )
      .bind(
        ORGANISATION_ID,
        joining.client.identity.userId,
        joining.personId,
        Date.now(),
      ),
  ]);
  return {
    userId: joining.client.identity.userId,
    personId: joining.personId,
    session: joining.client.session,
  };
}

async function member(
  organisationId: OrganisationId,
  name: string,
): Promise<Member> {
  const userId = newUserId();
  const personId = `person_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES (?, 'p54b', ?, ?, ?, 1, ?, ?)",
    ).bind(userId, userId, `${userId}@example.invalid`, name, now, now),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, name),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      )
      .bind(organisationId, userId, personId, now),
  ]);
  return {
    userId,
    personId,
    session: await issueControlSession({
      db: env.DB,
      userId,
      now,
      ttlMs: 1800000,
    }),
  };
}

async function source(owner: Member): Promise<CanonicalFileReference> {
  const now = Date.now();
  const handle = parseVaultHandle("vault:dropbox:p54b");
  if (!handle.ok) throw new Error(handle.error.code);
  const integration = await createActiveConnectedIntegration(
    fixtureDatabase(),
    {
      organisationId: ORGANISATION_ID,
      provider: "dropbox",
      providerSubjectId: "dbid:p54b",
      environment: "development",
      authMode: "shared_pantry_app",
      authority: { kind: "connection_credential", credentialRef: handle.value },
      grantedScopes: ["files.metadata.read", "files.content.read"],
      createdByUserId: owner.userId,
      providerAccountId: "dbid:p54b",
      accountKind: "account",
      displayName: "P54B Dropbox",
      capabilities: ["file.read"],
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
      now,
    },
  );
  const secret = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: ORGANISATION_ID,
    handle: handle.value,
    secret: {
      kind: "oauth_tokens",
      accessToken: "p54b-fixture",
      refreshToken: "p54b-fixture-refresh",
      expiry: { kind: "provider_managed" },
    },
    now,
  });
  if (!secret.ok) throw new Error(secret.error.code);
  const reference: CanonicalFileReference = {
    integrationAccountId: integration.account.integrationAccountId,
    provider: "dropbox",
    providerFileId: SOURCE_ID,
  };
  await createRequiredGrant({
    grantId: "grant_p54b_source",
    subject: { kind: "person", personId: owner.personId },
    target: {
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: reference.integrationAccountId,
      scope: {
        kind: "dropbox_file",
        providerFileId: SOURCE_ID,
        pathDisplay: `/${SOURCE_NAME}`,
      },
    },
    now,
  });
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO provider_resource_snapshot (snapshot_revision, organisation_id, integration_account_id, provider, environment, query_hash, created_at) VALUES ('snapshot_p54b', ?, ?, 'dropbox', 'development', 'p54b', ?)",
      )
      .bind(ORGANISATION_ID, reference.integrationAccountId, now),
    fixtureDatabase()
      .prepare(
        "INSERT INTO provider_discovered_resource (snapshot_revision, canonical_resource_id, provider_resource_id, provider_account_id, display_label, access_state, provider_revision, resource_kind) VALUES ('snapshot_p54b', 'resource_p54b', ?, 'dbid:p54b', ?, 'accessible', ?, 'dropbox_file')",
      )
      .bind(SOURCE_ID, SOURCE_NAME, SOURCE_REVISION),
  ]);
  return reference;
}

async function projectSource(
  owner: Member,
  reference: CanonicalFileReference,
): Promise<void> {
  const now = Date.now();
  await replaceFileGrantAdmissions({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_p54b_source",
    grantRevision: 1,
    admissions: [
      {
        grantId: "grant_p54b_source",
        grantRevision: 1,
        ...reference,
        containingScopeKey: `dropbox_file:${SOURCE_ID}`,
        providerRevision: { kind: "dropbox", rev: SOURCE_REVISION },
      },
    ],
    admittedAt: now,
  });
  const command = createFileProjectionCommand({
    organisationId: ORGANISATION_ID,
    grantId: "grant_p54b_source",
    grantRevision: 1,
    ...reference,
    sourceSequence: 1,
    providerRevision: { kind: "dropbox", rev: SOURCE_REVISION },
    visibilityKey: encodeContextVisibility({
      kind: "person",
      personId: owner.personId,
    }),
  });
  const sourceReader = new ProviderFileProjectionSourceReader({
    env: {
      ...env,
      DROPBOX_OAUTH_CLIENT_ID: "p54b-client",
      DROPBOX_OAUTH_CLIENT_SECRET: "p54b-secret",
    },
    db: fixtureDatabase(),
    storeCredential: storeFilePlacementCredential.bind(
      null,
      env,
      await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    ),
    command,
    fetcher: fetch,
    now,
  });
  const metadata = await sourceReader.readMetadata(command);
  if (!metadata.ok) throw new Error(metadata.error.code);
  await upsertFileResourceSource({
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    metadata: {
      integrationAccountId: reference.integrationAccountId,
      provider: reference.provider,
      providerFileId: reference.providerFileId,
      providerRevision: metadata.value.providerRevision,
      displayName: metadata.value.displayName,
      displayPath: metadata.value.displayPath,
      mediaType: metadata.value.mediaType,
      deepLink: metadata.value.deepLink,
      observedAt: now,
    },
    now,
  });
  expect(
    await applyFileProjectionCommand({
      scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
      command,
      sourceReader,
      now,
    }),
  ).toMatchObject({ kind: "applied" });
}

async function protectedMetadata(
  user: Member,
  reference: CanonicalFileReference,
  policyVersion: number,
  observations: FileToolObservation[],
) {
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
  });
  if (membershipRevision === null)
    throw new Error("Organisation membership missing");
  const authority = buildControlAuthority({
    organisationId: ORGANISATION_ID,
    userId: user.userId,
    requesterPersonId: user.personId,
    membershipRevision,
    role: "admin",
  }).requestAuthority;
  const executionScope = await requireOrganisationExecutionScope(
    env,
    ORGANISATION_ID,
  );
  const compiled = await compileTurnAuthority({
    db: fixtureDatabase(),
    accountAccess: executionScope.accountAccess,
    userAuthority: {
      kind: "authenticated_session",
      nativeSessionId: user.session.session.controlSessionId,
    },
    action: "disclose",
    organisationId: ORGANISATION_ID,
    requestAuthority: authority,
    policy: { version: policyVersion },
  });
  if (!compiled.ok) throw new Error(compiled.error.code);
  const identities = await deriveDirectCaseIdentities(
    `${ORGANISATION_ID}:portal-chat:${user.userId}:${newConversationId()}`,
  );
  if (!identities.ok) throw new Error(identities.error.code);
  return readGrantedFile({
    env,
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    authorizeExecution: authorizeMetadataFixture,
    storeCredential: storeFilePlacementCredential.bind(
      null,
      env,
      await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    ),
    caseId: identities.value.caseId,
    requestAuthority: compiled.value.requestAuthority,
    visibility: audiencesForAdmission(
      compiled.value.requestAuthority,
      identities.value.caseId,
    ),
    reference,
    startSegment: 0,
    fetcher: fetch,
    now: Date.now(),
    observe: recordObservation.bind(null, observations),
  });
}
async function recordObservation(
  observations: FileToolObservation[],
  observation: FileToolObservation,
): Promise<void> {
  observations.push(observation);
}
function serializeObservation(observation: FileToolObservation) {
  return {
    label: observation.inputLabel.toJSON(),
    evidence: observation.evidence.toJSON(),
  };
}
async function inspectFlow(
  sessionId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  const flow = await readSessionInformationFlow(state.storage.sql, {
    organisationId: ORGANISATION_ID,
    sessionId,
  });
  if (!flow.ok || flow.value === null)
    throw new Error("Session information flow missing");
  return {
    context: flow.value.context.toJSON(),
    observations: flow.value.observations.map(serializeEvidence),
  };
}
function serializeEvidence(evidence: FileToolObservation["evidence"]) {
  return evidence.toJSON();
}
function request(user: Member, path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      origin: "https://localhost",
      cookie: `pantry_session=${user.session.token}; pantry_csrf=${user.session.csrfToken}`,
      "x-pantry-csrf": user.session.csrfToken,
      "content-type": "application/json",
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}
async function get(
  user: Member,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await request(user, path, null);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Invalid response");
  return body;
}
async function workKind(
  user: Member,
  id: ConversationId,
): Promise<string | null> {
  return (
    (
      await readConversation(
        fixtureDatabase(),
        { organisationId: ORGANISATION_ID, userId: user.userId },
        id,
      )
    )?.conversation.work.kind ?? null
  );
}
function modelCalls(provider: Provider): number {
  return provider.prompts.length;
}
async function reply(
  provider: Provider,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  provider.prompts.push(JSON.stringify(await request.json()));
  const gate = provider.gate;
  if (gate.kind === "held") {
    await gate.resume.promise;
  }
  return openRouterText(
    JSON.stringify({
      kind: "reply",
      text: `Project context acknowledged ${provider.prompts.length}.`,
    }),
    `p54b_${provider.prompts.length}`,
  );
}
function refreshToken(): Response {
  return HttpResponse.json({
    access_token: "p54b-refreshed",
    expires_in: 14400,
  });
}
function dropboxAccount(): Response {
  return HttpResponse.json({
    account_id: "dbid:p54b",
    email: "p54b@example.invalid",
    name: { display_name: "P54B source owner" },
    root_info: { home_namespace_id: "p54b-home" },
  });
}
function dropboxMetadata(provider: Provider): Response {
  provider.metadataReads += 1;
  return HttpResponse.json({
    ".tag": "file",
    id: SOURCE_ID,
    name: SOURCE_NAME,
    path_display: `/${SOURCE_NAME}`,
    rev: SOURCE_REVISION,
    server_modified: "2026-10-03T00:00:00Z",
    size: 100,
    is_downloadable: true,
  });
}
function unexpectedBody(provider: Provider): Response {
  provider.bodyReads += 1;
  return new Response("Source bodies are outside this metadata journey", {
    status: 500,
  });
}

async function authorizeMetadataFixture(): Promise<void> {}
