import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { connectRealAccountPlatform } from "./real-account-platform-fixture";
import {
  resolveUser,
  upsertUser,
  issueControlSession,
} from "../src/data/control-plane";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { parseOrganisationPlacementProfile } from "../src/placement";
import { requireConversationId } from "./test-ids";
import { defaultProjectSql } from "./fixtures/default-project";
vi.mock("../src/chat/forks", async function forkModule(importOriginal) {
  return {
    ...(await importOriginal<typeof import("../src/chat/forks")>()),
    bindCompletedChatHistory: async function bindMockHistory(
      _env: unknown,
      _scope: unknown,
      conversation: import("../src/chat/conversation").Conversation,
    ) {
      return conversation;
    },
  };
});
import { timelineVisibleMessages } from "../src/chat/conversation";
import { chatActionFlowSink } from "../src/chat/turn/timeline";
import { resumeConversationExecution } from "../src/chat/application";
import {
  createCustomConnectorDraft,
  prepareCustomConnectorDraftDocument,
} from "../src/custom-connectors/revisions";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL as NodeUrl } from "node:url";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SqliteD1Database } from "./sqlite-d1";
import {
  FlowBinding,
  FlowLabel,
  InformationFlowContext,
  evaluateFlowLabelSink,
  organisationAuthzFromPolicy,
} from "../src/policy/information-flow";
import { defaultDenyPolicy } from "../src/policy-snapshot";
import { CAPABILITY_KEYS } from "../src/authorization/capability-catalogue";
import { buildControlAuthority } from "../src/request-authority";
import { deriveDirectCaseIdentities } from "../src/actors/case-direct-processing";
import { projectEmailOperationalProposal } from "../src/data/email-operational";
import {
  bakeryEffectDeliveryTarget,
  createBakerySurfaceAttachment,
  createBakerySurfaceEffect,
  createBakerySurfaceReceipt,
} from "@purin-labs/bakery-model/bakery-surface";

const mocks = vi.hoisted(function chatMocks() {
  return {
    model: vi.fn(),
    generate: vi.fn(),
    membership: vi.fn(),
    documentation: vi.fn(),
    interrupt: vi.fn(),
    schedule: vi.fn(),
    caseActor: {
      prepareDirectTurn: vi.fn(),
      assignSession: vi.fn(),
      beginAssignment: vi.fn(),
      settleAssignment: vi.fn(),
      abandonAssignment: vi.fn(),
      assignmentLifecycles: vi.fn(),
      acceptSessionProposal: vi.fn(),
      acceptDeliveryReceipt: vi.fn(),
      holdOutput: vi.fn(),
      rejectOutput: vi.fn(),
      inspect: vi.fn(),
      transitionEmailProposal: vi.fn(),
      readTail: vi.fn(),
    },
  };
});
vi.mock("../src/policy-snapshot", async function policyModule(importOriginal) {
  const original =
    await importOriginal<typeof import("../src/policy-snapshot")>();
  // The current organisation policy, with no capability rules.
  return {
    ...original,
    readCurrentOrganisationPolicySnapshot: async () => ({
      ok: true,
      value: original.defaultDenyPolicy({ now: 0 }),
    }),
  };
});
vi.mock("../src/models/route", async function modelModule(importOriginal) {
  return {
    ...(await importOriginal<typeof import("../src/models/route")>()),
    resolveOrganisationModelRoute: mocks.model,
    resolveOrganisationModelRouteAtScope: mocks.model,
  };
});
vi.mock(
  "../src/data/control-plane",
  async function membershipModule(importOriginal) {
    return {
      ...(await importOriginal<typeof import("../src/data/control-plane")>()),
      readActiveOrganisationMembershipRevision: mocks.membership,
      resolveControlSessionById: async function resolveSession() {
        return {
          ok: true,
          value: { userId: "user_2eee7198-ed08-56f8-9771-97f608f2cb4c" },
        };
      },
    };
  },
);
vi.mock(
  "../src/actors/case-direct-processing",
  async function runtimeModule(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("../src/actors/case-direct-processing")
      >()),
      processConversationCaseCommand: mocks.generate,
    };
  },
);
vi.mock("../src/actors/actor-router", function actorRouterModule() {
  return {
    resolveActiveSessionActor: async function resolveSession() {
      return {
        ok: true,
        value: {
          interruptCanonicalEmbeddedHarnessTurn: mocks.interrupt,
        },
      };
    },
    resolveActiveCaseActorAtScope: async function resolveCase() {
      return { ok: true, value: { scheduleConversation: mocks.schedule } };
    },
    resolveActiveSessionActorAtScope: async function prepareSession() {
      return { ok: true, value: {} };
    },
    resolveActiveSessionActorAtPlacement: vi.fn(async function resolveActor() {
      return {
        ok: true,
        value: {
          interruptCanonicalEmbeddedHarnessTurn: mocks.interrupt,
          readConfirmedContextObservations: async function observations() {
            return [];
          },
        },
      };
    }),
  };
});
vi.mock(
  "../src/custom-connectors/authoring",
  async function authoringModule(importOriginal) {
    return {
      ...(await importOriginal<
        typeof import("../src/custom-connectors/authoring")
      >()),
      readConnectorDocumentation: mocks.documentation,
    };
  },
);

import { handlePortalChat as nativeAdmitPortalChat } from "../src/control/routes/chat";
import { handlePortalChatConversation as nativeHandlePortalChatConversation } from "../src/control/routes/chat/conversation";
import { handlePortalChatCancel as nativeHandlePortalChatCancel } from "../src/control/routes/chat/cancel";
import type { ConversationExecution } from "../src/chat/execution";
import {
  conversationTimeline,
  parseConversation,
  parseChatCommand,
  parseChatModelAction,
} from "../src/chat/conversation";
import {
  parseUserId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "../src/ids";
import {
  advanceConversationRead,
  listConversationDirectory,
  readConversation,
  saveConversation,
  updateConversationDraft,
} from "../src/chat/store";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const organisation = parseOrganisationId("organisation_chat_test");
const identity = parseUserId("user_2eee7198-ed08-56f8-9771-97f608f2cb4c");
const emailAccount = parseIntegrationAccountId("intacc_chat_email");
if (!organisation.ok || !identity.ok || !emailAccount.ok)
  throw new Error("Invalid test identity");
const scope = { organisationId: organisation.value, userId: identity.value };
const baseline = singleDatabaseSchema();
let database: DatabaseSync;
let env: UnitTestEnv;
let execution: OrganisationExecutionScope;
let binding: unknown;
let authenticatedHeaders: Readonly<Record<string, string>>;
let pendingExecution: ConversationExecution | null = null;
let workerRunning = false;

beforeEach(async function setup() {
  vi.clearAllMocks();
  mocks.generate.mockReset();
  mocks.documentation.mockReset();
  pendingExecution = null;
  workerRunning = false;
  mocks.schedule.mockImplementation(recordExecution);
  database = new DatabaseSync(":memory:");
  database.exec(baseline);
  database.exec(`
    INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES ('organisation_chat_test', 'chat-test', 'Chat test', 1);
    ${defaultProjectSql("organisation_chat_test")}
    INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES ('user_2eee7198-ed08-56f8-9771-97f608f2cb4c', 'https://accounts.google.com', 'chat', 'chat@example.com', 'Chat admin', 1, 1, 1);
    INSERT INTO person (organisation_id, person_id, display_name) VALUES ('organisation_chat_test', 'person_chat_test', 'Chat admin');
    INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES ('organisation_chat_test', 'user_2eee7198-ed08-56f8-9771-97f608f2cb4c', 'person_chat_test', 'admin', 'active', 1);
    INSERT INTO organisation_onboarding (organisation_id, environment, lifecycle, capability_profile, configuration_version, projection_revision, activation_receipt_id, activated_at, updated_at) VALUES ('organisation_chat_test', 'development', 'active', 'read_and_propose', 1, 1, 'receipt_chat', 1, 1);
    INSERT INTO provider_connection (
      provider_connection_id, organisation_id, provider, auth_mode, authority_kind,
      credential_generation, credential_ref, lifecycle, granted_scopes,
      created_by_user_id, created_at, updated_at, environment,
      provider_subject_id, authorization_product
    ) VALUES (
      'connection_chat_email', 'organisation_chat_test', 'gmail', 'shared_satyr_app',
      'connection_credential', 1, 'vault:chat-email', 'active', '["gmail.send"]',
      'user_2eee7198-ed08-56f8-9771-97f608f2cb4c', 1, 1, 'development', 'google-chat-email', 'send_only'
    );
    INSERT INTO integration_account (
      integration_account_id, organisation_id, provider_connection_id, provider,
      provider_account_id, account_kind, display_name, lifecycle,
      capability_set, audience_policy, retention_policy, created_at, updated_at,
      environment
    ) VALUES (
      'intacc_chat_email', 'organisation_chat_test', 'connection_chat_email', 'gmail',
      'google-chat-email', 'gmail_send_only', 'Chat email', 'active',
      '["email.operational.propose"]', '{"kind":"operator"}',
      '{"kind":"organisation_default"}', 1, 1, 'development'
    );
  `);
  env = platformEnv({
    DB: new SqliteD1Database(database) as unknown as SingleDatabase,
    MESSAGE_LINK_FETCH: {},
    PANTRY_PUBLIC_ORIGIN: "https://portal.example",
    PANTRY_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
      databaseBinding: "DB",
      kind: "affinity",
      placementCellId: "chat-test",
      locationHint: "wnam",
    }),
  });
  const placement = parseOrganisationPlacementProfile(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!placement.ok) throw new Error(placement.error.code);
  await ensureInitialOrganisationPlacement({
    db: env.DB,
    organisationId: scope.organisationId,
    placement: placement.value,
    environment: "development",
    now: 1,
  });
  const resolved = await OrganisationExecutionScope.resolve(
    env,
    scope.organisationId,
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  execution = resolved.value;
  const actor = await resolveUser({ db: env.DB, userId: scope.userId });
  if (actor === null) throw new Error("Missing chat actor");
  const owner = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "chat-owner",
      email: "chat-owner@example.test",
      displayName: "Chat owner",
      emailVerified: true,
    },
    now: Date.now(),
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_chat_owner', 'Chat owner')",
    ).bind(scope.organisationId),
    env.DB.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, 'person_chat_owner', 'owner', 'active', ?)",
    ).bind(scope.organisationId, owner.userId, Date.now()),
  ]);
  const actorSession = await issueControlSession({
    db: env.DB,
    userId: actor.userId,
    now: Date.now(),
    ttlMs: 3600000,
  });
  const ownerSession = await issueControlSession({
    db: env.DB,
    userId: owner.userId,
    now: Date.now(),
    ttlMs: 3600000,
  });
  const account = await connectRealAccountPlatform(env, {
    organisationId: scope.organisationId,
    owner: { user: owner, session: ownerSession.session },
    members: [
      {
        slot: "operator",
        actor: { user: actor, session: actorSession.session },
      },
    ],
  });
  env = account.env;
  execution = await requireOrganisationExecutionScope(
    env,
    scope.organisationId,
  );
  authenticatedHeaders = {
    cookie: `satyr_control_session=${actorSession.token}; satyr_control_csrf=${actorSession.csrfToken}`,
    origin: "https://portal.example",
    "x-satyr-csrf": actorSession.csrfToken,
  };
  mocks.model.mockResolvedValue({
    ok: true,
    value: {
      keySource: "organisation_byo",
      provider: "openai",
      model: "test-model",
      byoKeyRef: "vault_model",
    },
  });
  mocks.membership.mockResolvedValue(1);
  mocks.interrupt.mockResolvedValue({ ok: true });
  const context = await InformationFlowContext.create({
    organisationId: scope.organisationId,
    sessionId: "session_chat_test",
    authorityPartitionDigest: "a".repeat(64),
  });
  if (!context.ok) throw new Error(context.error.code);
  binding = FlowBinding.fromContext(context.value, "turn_chat_test").toJSON();
});
afterEach(function cleanup() {
  database.close();
});

function recordExecution(input: ConversationExecution): void {
  pendingExecution = input;
}

async function runScheduledConversation(
  input: ConversationExecution,
): Promise<void> {
  workerRunning = true;
  try {
    await resumeConversationExecution(
      env,
      await requireOrganisationExecutionScope(env, input.scope.organisationId),
      input,
      mocks.caseActor,
    );
  } finally {
    workerRunning = false;
  }
}

// Existing journeys drive the admitted actor job and read its projection;
// the E2E suite verifies real actor scheduling, alarms, and request lifetimes.
async function handlePortalChat(
  request: Request,
  bindings: UnitTestEnv,
  organisationId: string,
  background: { waitUntil(task: Promise<unknown>): void } | null = null,
): Promise<Response> {
  const response = await admitPortalChat(
    authenticatedChatRequest(request),
    bindings,
    organisationId,
  );
  const pending = pendingExecution;
  pendingExecution = null;
  if (pending === null || workerRunning) {
    background?.waitUntil(Promise.resolve());
    return response;
  }
  const task = runScheduledConversation(pending);
  if (background !== null) {
    background.waitUntil(task);
    return response;
  }
  await task;
  return admitPortalChat(
    authenticatedChatRequest(
      new Request(
        `https://portal.example/chat?conversation=${pending.conversationId}`,
      ),
    ),
    bindings,
    organisationId,
  );
}

function admitPortalChat(
  ...input: Parameters<typeof nativeAdmitPortalChat>
): ReturnType<typeof nativeAdmitPortalChat> {
  input[0] = authenticatedChatRequest(input[0]);
  return nativeAdmitPortalChat(...input);
}

function handlePortalChatConversation(
  ...input: Parameters<typeof nativeHandlePortalChatConversation>
): ReturnType<typeof nativeHandlePortalChatConversation> {
  input[0] = authenticatedChatRequest(input[0]);
  return nativeHandlePortalChatConversation(...input);
}

function handlePortalChatCancel(
  ...input: Parameters<typeof nativeHandlePortalChatCancel>
): ReturnType<typeof nativeHandlePortalChatCancel> {
  input[0] = authenticatedChatRequest(input[0]);
  return nativeHandlePortalChatCancel(...input);
}

function authenticatedChatRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const [key, value] of Object.entries(authenticatedHeaders))
    headers.set(key, value);
  return new Request(request, { headers });
}

function request(
  text: string,
  requestId = "request_chat_first",
  model = "test-model",
  conversationId = "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
): Request {
  return new Request(
    "https://portal.example/v1/control/organisations/organisation_chat_test/chat",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "message",
        conversationId,
        requestId,
        model,
        text,
      }),
    },
  );
}
function retryRequest(
  requestId = "request_chat_first",
  conversationId = "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
): Request {
  return new Request("https://portal.example/chat", {
    method: "POST",
    body: JSON.stringify({
      kind: "retry",
      conversationId,
      requestId,
      model: "test-model",
    }),
  });
}
function metadataRequest(
  conversationId: string,
  action: "pin" | "unpin" | "archive" | "restore",
  expectedRevision = 1,
): Request {
  return new Request(
    `https://portal.example/v1/control/organisations/organisation_chat_test/chat/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        action === "archive" || action === "restore"
          ? { action, expectedRevision }
          : { action },
      ),
    },
  );
}
function conversationId(conversation: { readonly id: string }): string {
  return conversation.id;
}
function isAssistantResponse(event: { readonly kind: string }): boolean {
  return event.kind === "assistant";
}
function completed(
  action: unknown,
  modelUsage?: {
    readonly callsWithUsage: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly totalTokens: number;
  },
): unknown {
  return {
    ok: true,
    value: {
      kind: "completed",
      caseId: "case_chat_test",
      sessionId: "session_chat_test",
      assignmentId: "assignment_chat_test",
      completion: {
        outcome: { status: "success", summary: null, artifacts: [] },
        finalMessage: JSON.stringify(action),
        flowBinding: binding,
        ...(modelUsage === undefined ? {} : { modelUsage }),
      },
    },
  };
}
async function readResponse(): Promise<Response> {
  return handlePortalChat(
    new Request(
      "https://portal.example/v1/control/organisations/organisation_chat_test/chat?conversation=conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    ),
    env,
    scope.organisationId,
  );
}

function readyConversation(id: string, title: string) {
  return parseConversation({
    id,
    title,
    modelRoute: {
      keySource: "organisation_byo",
      provider: "openai",
      model: "test-model",
      byoKeyRef: "vault_model",
    },
    timeline: [],
    documents: [],
    completedRequests: [],
    work: { kind: "ready" },
  });
}

describe("persistent portal chat", function chatSuite() {
  it("returns only metadata for email reviews owned by the selected conversation Case", async function scopesEmailReviews() {
    const conversation = readyConversation(
      requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
      "Email supplier",
    );
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        conversation,
        0,
      ),
    ).toEqual({
      kind: "saved",
    });
    const identities = await deriveDirectCaseIdentities(
      `${scope.organisationId}:portal-chat:${scope.userId}:${conversation.id}`,
    );
    expect(identities.ok).toBe(true);
    if (!identities.ok) return;
    const matching = await projectEmailOperationalProposal({
      scope: await requireOrganisationExecutionScope(env, scope.organisationId),
      integrationAccountId: emailAccount.value,
      proposalId: "proposal_chat_email",
      caseId: identities.value.caseId,
      target: {
        kind: "supplier_contact",
        supplierId: "supplier_chat",
        contactId: "primary_email",
        contactRevision: 1,
      },
      currentVersion: 1,
      targetDigest: "1".repeat(64),
      subjectDigest: "2".repeat(64),
      bodyDigest: "3".repeat(64),
      snapshotDigest: "4".repeat(64),
      lifecycleKind: "awaiting_approval",
      providerMessageId: null,
      providerThreadId: null,
      indeterminateRfcMessageId: null,
      createdAt: 10,
      now: 10,
    });
    expect(matching).toEqual({ ok: true, value: null });
    const unrelated = await projectEmailOperationalProposal({
      scope: await requireOrganisationExecutionScope(env, scope.organisationId),
      integrationAccountId: emailAccount.value,
      proposalId: "proposal_other_email",
      caseId: "case_other_conversation",
      target: {
        kind: "supplier_contact",
        supplierId: "supplier_other",
        contactId: "primary_email",
        contactRevision: 1,
      },
      currentVersion: 1,
      targetDigest: "5".repeat(64),
      subjectDigest: "6".repeat(64),
      bodyDigest: "7".repeat(64),
      snapshotDigest: "8".repeat(64),
      lifecycleKind: "awaiting_approval",
      providerMessageId: null,
      providerThreadId: null,
      indeterminateRfcMessageId: null,
      createdAt: 11,
      now: 11,
    });
    expect(unrelated).toEqual({ ok: true, value: null });

    const response = await readResponse();
    const body = await response.json<{
      readonly emailReviews: readonly Record<string, unknown>[];
    }>();
    expect(body.emailReviews).toEqual([
      expect.objectContaining({
        kind: "operational_new_message",
        proposal_id: "proposal_chat_email",
        case_id: identities.value.caseId,
        version: 1,
        lifecycle_kind: "awaiting_approval",
      }),
    ]);
    expect(JSON.stringify(body.emailReviews)).not.toContain("subject");
    expect(JSON.stringify(body.emailReviews)).not.toContain("body");
  });

  it("pins, archives, and restores private conversations idempotently", async function managesConversationDirectory() {
    const first = parseConversation({
      id: "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
      title: "First chat",
      modelRoute: {
        keySource: "organisation_byo",
        provider: "openai",
        model: "test-model",
        byoKeyRef: "vault_model",
      },
      documents: [],
      work: { kind: "ready" as const },
      completedRequests: [],
      timeline: [],
      surfaceEventCursor: 0,
      pendingInputs: [],
      latestSequence: 0,
      lastReadSequence: 0,
      draftText: "",
      draftUpdatedAt: null,
      effort: null,
    });
    const second = parseConversation({
      id: "conv_52f2bc55-f9ee-5ff8-9116-89c8e274b69a",
      title: "Second chat",
      modelRoute: first.modelRoute,
      documents: [],
      work: { kind: "ready" as const },
      completedRequests: [],
      timeline: [],
      surfaceEventCursor: 0,
      pendingInputs: [],
      latestSequence: 0,
      lastReadSequence: 0,
      draftText: "",
      draftUpdatedAt: null,
      effort: null,
    });
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        first,
        0,
      ),
    ).toEqual({
      kind: "saved",
    });
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        second,
        0,
      ),
    ).toEqual({
      kind: "saved",
    });

    const pin = await handlePortalChatConversation(
      metadataRequest("conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27", "pin"),
      env,
      scope.organisationId,
      "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
    );
    expect(pin.status).toBe(200);
    const pinned = await pin.json<{
      conversation: { lifecycle: string; pinnedAt: number };
    }>();
    expect(pinned.conversation.lifecycle).toBe("active");
    expect(pinned.conversation.pinnedAt).toEqual(expect.any(Number));

    const replay = await handlePortalChatConversation(
      metadataRequest("conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27", "pin"),
      env,
      scope.organisationId,
      "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
    );
    expect(
      (await replay.json<{ conversation: { pinnedAt: number } }>()).conversation
        .pinnedAt,
    ).toBe(pinned.conversation.pinnedAt);
    expect((await listConversationDirectory(env.DB, scope)).active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
          pinnedAt: pinned.conversation.pinnedAt,
        }),
      ]),
    );

    const archive = await handlePortalChatConversation(
      metadataRequest("conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27", "archive"),
      env,
      scope.organisationId,
      "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
    );
    expect(archive.status).toBe(200);
    const archivedDirectory = await listConversationDirectory(env.DB, scope);
    expect(archivedDirectory.active.map(conversationId)).toEqual([
      "conv_52f2bc55-f9ee-5ff8-9116-89c8e274b69a",
    ]);
    expect(archivedDirectory.archived[0]).toMatchObject({
      id: "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
      lifecycle: "archived",
      pinnedAt: pinned.conversation.pinnedAt,
    });
    expect(
      (
        await handlePortalChat(
          request(
            "Continue",
            "request_archived",
            "test-model",
            "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
          ),
          env,
          scope.organisationId,
        )
      ).status,
    ).toBe(409);

    const restore = await handlePortalChatConversation(
      metadataRequest(
        "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
        "restore",
        1,
      ),
      env,
      scope.organisationId,
      "conv_73ab3e3e-12cf-50ce-941e-f64df2c6ed27",
    );
    expect(restore.status).toBe(200);
    expect((await listConversationDirectory(env.DB, scope)).archived).toEqual(
      [],
    );
  });

  it("preserves a personal draft on archive while an active response continues", async function protectsArchivedState() {
    const conversation = readyConversation(
      "conv_d2ba3e01-3127-507d-b140-ea5e298af571",
      "Archive test",
    );
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        conversation,
        0,
      ),
    ).toEqual({
      kind: "saved",
    });
    expect(
      (
        await updateConversationDraft(
          execution,
          scope.userId,
          conversation.id,
          "Unsaved private draft",
          null,
          10,
        )
      ).ok,
    ).toBe(true);
    const archive = await handlePortalChatConversation(
      metadataRequest(conversation.id, "archive", 1),
      env,
      scope.organisationId,
      conversation.id,
    );
    expect(archive.status).toBe(200);
    expect(
      (await readConversation(env.DB, scope, conversation.id))?.conversation,
    ).toMatchObject({ draftText: "Unsaved private draft", draftUpdatedAt: 10 });

    const expired = parseConversation({
      ...readyConversation(
        "conv_f84d0b19-25e5-5ac8-be10-24545ec4cb92",
        "Expired response",
      ),
      work: {
        kind: "running",
        requestId: "request_expired",
        lease: "lease_expired",
        expiresAt: 0,
        stream: {
          step: 0,
          sessionId: "session_expired",
          turnId: "turn_expired",
        },
      },
    });
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        expired,
        0,
      ),
    ).toEqual({
      kind: "saved",
    });
    const rejected = await handlePortalChatConversation(
      metadataRequest(expired.id, "archive"),
      env,
      scope.organisationId,
      expired.id,
    );
    expect(rejected.status).toBe(200);
  });

  it("keeps private context out of unread cursors and isolates draft conflicts", async function protectsConversationProjections() {
    const conversation = parseConversation({
      ...readyConversation(
        "conv_033c2636-fa7e-5677-b65a-b28266e16040",
        "Projection test",
      ),
      timeline: [
        {
          kind: "user",
          eventId: "request_projection",
          sequence: 1,
          requestId: "request_projection",
          createdAt: 1,
          text: "Hello",
          parts: [{ kind: "text", text: "Hello" }],
        },
        {
          kind: "context",
          eventId: "context_projection",
          sequence: 2,
          requestId: "request_projection",
          createdAt: 2,
          text: "Private tool context",
        },
      ],
      latestSequence: 2,
      lastReadSequence: 0,
    });
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        conversation,
        0,
      ),
    ).toEqual({
      kind: "saved",
    });
    expect(
      await advanceConversationRead(
        execution,
        scope.userId,
        conversation.id,
        2,
      ),
    ).toEqual({ ok: false, code: "chat_read_invalid" });
    expect(
      await advanceConversationRead(
        execution,
        scope.userId,
        conversation.id,
        1,
      ),
    ).toEqual({ ok: true, latestSequence: 1, lastReadSequence: 1 });

    const savedDraft = await updateConversationDraft(
      execution,
      scope.userId,
      conversation.id,
      "Draft after read update",
      null,
      20,
    );
    expect(savedDraft).toMatchObject({
      ok: true,
      draft: "Draft after read update",
    });
    expect(
      await updateConversationDraft(
        execution,
        scope.userId,
        conversation.id,
        "Conflicting draft",
        null,
        21,
      ),
    ).toMatchObject({
      ok: false,
      code: "chat_revision_conflict",
      serverDraft: "Draft after read update",
      serverUpdatedAt: 20,
    });
    expect(
      (await listConversationDirectory(env.DB, scope)).active[0],
    ).toMatchObject({
      latestSequence: 1,
      lastReadSequence: 1,
    });
  });

  it("applies link-read policy to documentation and draft policy to connector artifacts", async function classifiesAgentActions() {
    const authority = buildControlAuthority({
      organisationId: scope.organisationId,
      requesterPersonId: "person_chat_test",
      userId: scope.userId,
      membershipRevision: 1,
      role: "admin",
    }).requestAuthority;
    const label = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: scope.organisationId },
        readers: [{ kind: "person", personId: "person_chat_test" }],
      },
    ]);
    // The organisation's current policy denies connector drafts only.
    const base = defaultDenyPolicy({ now: 0 });
    const organisationAuthz = organisationAuthzFromPolicy({
      ...base,
      authz: {
        ...base.authz,
        deniedTools: [CAPABILITY_KEYS.customConnectorDraft],
      },
    });
    if (!label.ok) throw new Error(label.error.code);
    const documentation = evaluateFlowLabelSink({
      flowLabel: label.value,
      organisationAuthz,
      sink: chatActionFlowSink(
        {
          kind: "read_documentation",
          url: "https://docs.shipandco.com/",
        },
        authority,
        requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
      ),
    });
    const definition = evaluateFlowLabelSink({
      flowLabel: label.value,
      organisationAuthz,
      sink: chatActionFlowSink(
        { kind: "definition", document: {} },
        authority,
        requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
      ),
    });
    const reply = evaluateFlowLabelSink({
      flowLabel: label.value,
      organisationAuthz,
      sink: chatActionFlowSink(
        { kind: "reply", text: "I found the API documentation." },
        authority,
        requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
      ),
    });
    expect(documentation.kind).toBe("allow");
    expect(definition.kind).toBe("deny");
    expect(reply.kind).toBe("allow");
  });

  it("settles an exact cancellation idempotently before stale output can publish", async function cancelsExactlyOnce() {
    const generation = deferred<unknown>();
    mocks.generate.mockReturnValueOnce(generation.promise);
    const tasks: Promise<unknown>[] = [];
    await handlePortalChat(request("First"), env, scope.organisationId, {
      waitUntil: tasks.push.bind(tasks),
    });
    const running = await readConversation(
      env.DB,
      scope,
      "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    );
    if (running?.conversation.work.kind !== "running")
      throw new Error("Expected running conversation");
    const cancellationBody = {
      conversationId: requireConversationId(
        "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
      ),
      requestId: running.conversation.work.requestId,
      sessionId: running.conversation.work.stream.sessionId,
      turnId: running.conversation.work.stream.turnId,
      cancellationId: "cancel_chat_exact",
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handlePortalChatCancel(
        new Request("https://portal.example/chat/cancel", {
          method: "POST",
          body: JSON.stringify(cancellationBody),
        }),
        env,
        scope.organisationId,
      );
      expect(response.status).toBe(200);
    }
    const cancelled = await readConversation(
      env.DB,
      scope,
      requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
    );
    expect(cancelled?.conversation.work.kind).toBe("ready");
    expect(
      cancelled?.conversation.timeline?.filter(eventIsCancellation),
    ).toHaveLength(1);
    generation.resolve(completed({ kind: "reply", text: "Stale reply" }));
    await Promise.all(tasks);
    expect(
      JSON.stringify(
        (
          await readConversation(
            env.DB,
            scope,
            "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
          )
        )?.conversation,
      ),
    ).not.toContain("Stale reply");
  });

  it("replays an accepted retry while the retried response is running", async function replaysActiveRetry() {
    mocks.generate.mockResolvedValueOnce({
      ok: false,
      error: { code: "conversation_turn_failed" },
    });
    await handlePortalChat(request("Retry me"), env, scope.organisationId);
    const generation = deferred<unknown>();
    mocks.generate.mockReturnValueOnce(generation.promise);
    const tasks: Promise<unknown>[] = [];
    expect(
      (
        await handlePortalChat(retryRequest(), env, scope.organisationId, {
          waitUntil: tasks.push.bind(tasks),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await handlePortalChat(retryRequest(), env, scope.organisationId, {
          waitUntil: tasks.push.bind(tasks),
        })
      ).status,
    ).toBe(200);
    await expect.poll(generatedTurnCount).toBe(2);
    generation.resolve(completed({ kind: "reply", text: "Retried once." }));
    await Promise.all(tasks);
  });

  it("replays queued messages and withdrawals without duplicating work", async function replaysQueueCommands() {
    const generation = deferred<unknown>();
    mocks.generate.mockReturnValueOnce(generation.promise);
    const tasks: Promise<unknown>[] = [];
    await handlePortalChat(request("First"), env, scope.organisationId, {
      waitUntil: tasks.push.bind(tasks),
    });
    const queuedBody = {
      kind: "next",
      conversationId: requireConversationId(
        "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
      ),
      inputId: "input_idempotent",
      requestId: "request_idempotent",
      model: "test-model",
      text: "Second",
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const queued = await handlePortalChat(
        new Request("https://portal.example/chat", {
          method: "POST",
          body: JSON.stringify(queuedBody),
        }),
        env,
        scope.organisationId,
      );
      expect(queued.status).toBe(200);
    }
    const conflict = await handlePortalChat(
      new Request("https://portal.example/chat", {
        method: "POST",
        body: JSON.stringify({
          ...queuedBody,
          inputId: "input_conflict",
        }),
      }),
      env,
      scope.organisationId,
    );
    expect(conflict.status).toBe(409);
    const withdrawBody = {
      kind: "withdraw",
      conversationId: requireConversationId(
        "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
      ),
      inputId: "input_idempotent",
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const withdrawn = await handlePortalChat(
        new Request("https://portal.example/chat", {
          method: "POST",
          body: JSON.stringify(withdrawBody),
        }),
        env,
        scope.organisationId,
      );
      expect(withdrawn.status).toBe(200);
    }
    expect(
      (
        await readConversation(
          env.DB,
          scope,
          "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
        )
      )?.conversation.pendingInputs,
    ).toEqual([]);
    generation.resolve(completed({ kind: "reply", text: "First reply" }));
    await Promise.all(tasks);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("rebases a completed documentation step without repeating model or tool work", async function rebasesCompletedStep() {
    mocks.generate
      .mockResolvedValueOnce(
        completed(
          { kind: "read_documentation", url: "https://api.example.com/docs" },
          {
            callsWithUsage: 1,
            inputTokens: 10,
            outputTokens: 4,
            cachedInputTokens: 2,
            totalTokens: 14,
          },
        ),
      )
      .mockResolvedValueOnce(
        completed(
          { kind: "reply", text: "The documentation is ready." },
          {
            callsWithUsage: 1,
            inputTokens: 8,
            outputTokens: 6,
            cachedInputTokens: 1,
            totalTokens: 14,
          },
        ),
      );
    mocks.documentation.mockImplementationOnce(
      async function updateDraftDuringTool() {
        const draft = await updateConversationDraft(
          execution,
          scope.userId,
          requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
          "Keep this draft",
          null,
          Date.now(),
        );
        expect(draft.ok).toBe(true);
        return {
          ok: true,
          value: [
            {
              url: "https://api.example.com/docs",
              sha256: "a".repeat(64),
              text: "API reference",
              truncated: false,
            },
          ],
        };
      },
    );
    const response = await handlePortalChat(
      request("Read the API documentation at https://api.example.com/docs."),
      env,
      scope.organisationId,
    );
    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.documentation).toHaveBeenCalledTimes(1);
    const stored = await readConversation(
      env.DB,
      scope,
      "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    );
    expect(stored?.conversation.draftText).toBe("Keep this draft");
    expect(stored?.conversation.documents).toHaveLength(1);
    const assistant = stored?.conversation.timeline.findLast(
      function latestAssistant(event) {
        return event.kind === "assistant";
      },
    );
    expect(assistant).toMatchObject({
      kind: "assistant",
      usage: {
        requestId: "request_chat_first",
        inputTokens: 18,
        outputTokens: 10,
        cachedInputTokens: 3,
        totalTokens: 28,
      },
    });
  });

  it("projects settled BakeryOS commands and receipts into the chat timeline", async function bakerySurfaceTimeline() {
    const surfaceContext = await createBakerySurfaceAttachment({
      schemaVersion: 1,
      kind: "bakery-workspace",
      runOpenReview: null,
      surfaceSessionId: "surface-chat-timeline",
      surfaceEpoch: 2,
      capturedAt: 50,
      comparison: null,
      simulation: null,
      supportedCommands: ["inspect_surface"],
      active: {
        kind: "shift",
        source: "sample",
        view: {
          dock: "closed",
          camera: "perspective",
          labels: "auto",
          minimap: false,
          chrome: "shown",
        },
        sourceIdentity: { kind: "sample", id: "financier-sample" },
        variant: "normal",
        selection: { kind: "batch", id: "A", label: "Batch A" },
        selectedTask: null,
        playback: {
          cursorSeconds: 0,
          playback: "paused",
          speed: 120,
        },
        draft: { revision: 0, digest: "b".repeat(64) },
        pendingEdit: null,
        scenarioSaveProposal: null,
        run: {
          state: "complete",
          endSeconds: 480,
          lateBatches: 0,
          unfinishedBatches: 0,
        },
      },
    });
    const effect = await createBakerySurfaceEffect({
      effectId: "surface_effect_timeline_test",
      dispatchId: "surface_dispatch_timeline_test",
      deadlineAt: Date.now() + 60_000,
      command: {
        schemaVersion: 1,
        kind: "inspect_surface",
        target: {
          surfaceSessionId: surfaceContext.context.surfaceSessionId,
          surfaceEpoch: surfaceContext.context.surfaceEpoch,
        },
      },
    });
    const receipt = await createBakerySurfaceReceipt(effect, {
      kind: "completed",
      result: {
        kind: "succeeded",
        command: "inspect_surface",
        surface: surfaceContext,
        output: { kind: "surface" },
      },
    });
    const response = await admitPortalChat(
      new Request("https://portal.example/chat", {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          conversationId: requireConversationId(
            "conv_fc649128-5a01-5a9a-9ba9-ab760c8e6714",
          ),
          requestId: "request_surface_timeline",
          model: "test-model",
          text: "Inspect this workspace.",
          surfaceContext,
        }),
      }),
      env,
      scope.organisationId,
    );

    const admitted = await readConversation(
      env.DB,
      scope,
      requireConversationId("conv_fc649128-5a01-5a9a-9ba9-ab760c8e6714"),
    );
    if (admitted?.conversation.work.kind !== "running")
      throw new Error("Surface timeline conversation was not admitted");
    const backendRequestId = admitted.conversation.work.requestId;
    database
      .prepare(
        `INSERT INTO bakery_surface_effect_delivery (
           effect_id, organisation_id, user_id, session_id, turn_id,
           request_id, surface_session_id, surface_epoch, command_digest, effect_json,
           state_kind, receipt_json, deadline_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?)`,
      )
      .run(
        effect.effectId,
        scope.organisationId,
        scope.userId,
        "session_chat_test",
        "turn_chat_test",
        backendRequestId,
        bakeryEffectDeliveryTarget(effect).surfaceSessionId,
        bakeryEffectDeliveryTarget(effect).surfaceEpoch,
        effect.commandDigest,
        JSON.stringify(effect),
        JSON.stringify(receipt),
        effect.deadlineAt,
        40,
        60,
      );
    database
      .prepare(
        `INSERT INTO bakery_surface_timeline_event (
           organisation_id, user_id, session_id, turn_id, request_id,
           effect_id, event_kind, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?),
                  (?, ?, ?, ?, ?, ?, 'settled', ?)`,
      )
      .run(
        scope.organisationId,
        scope.userId,
        "session_chat_test",
        "turn_chat_test",
        backendRequestId,
        effect.effectId,
        40,
        scope.organisationId,
        scope.userId,
        "session_chat_test",
        "turn_chat_test",
        backendRequestId,
        effect.effectId,
        60,
      );
    mocks.generate.mockResolvedValueOnce(
      completed({ kind: "reply", text: "I inspected Kitchen." }),
    );

    if (pendingExecution === null)
      throw new Error("Missing scheduled conversation");
    await runScheduledConversation(pendingExecution);

    expect(response.status).toBe(200);
    const stored = await readConversation(
      env.DB,
      scope,
      requireConversationId("conv_fc649128-5a01-5a9a-9ba9-ab760c8e6714"),
    );
    expect(conversationTimeline(stored!.conversation)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: `surface_tool_started_${effect.effectId}`,
          kind: "tool_started",
          tool: expect.objectContaining({
            action: "Inspect Kitchen",
            risk: "read",
          }),
        }),
        expect.objectContaining({
          eventId: `surface_tool_settled_${effect.effectId}`,
          kind: "tool_settled",
          outcome: "succeeded",
          receipt: expect.objectContaining({
            receiptId: `surface_receipt_${effect.effectId}`,
            state: "succeeded",
          }),
        }),
      ]),
    );
  });

  it("rejects a BakeryOS observation whose accepted digest no longer matches", async function rejectsChangedBakerySurfaceContext() {
    const surfaceContext = await createBakerySurfaceAttachment({
      schemaVersion: 1,
      kind: "bakery-workspace",
      runOpenReview: null,
      surfaceSessionId: "surface-chat-tampered",
      surfaceEpoch: 1,
      capturedAt: 50,
      comparison: null,
      simulation: null,
      supportedCommands: ["inspect_surface"],
      active: {
        kind: "shift",
        source: "sample",
        view: {
          dock: "closed",
          camera: "perspective",
          labels: "auto",
          minimap: false,
          chrome: "shown",
        },
        sourceIdentity: { kind: "sample", id: "financier-sample" },
        variant: "normal",
        selection: { kind: "batch", id: "A", label: "Batch A" },
        selectedTask: null,
        playback: {
          cursorSeconds: 0,
          playback: "paused",
          speed: 120,
        },
        draft: { revision: 0, digest: "c".repeat(64) },
        pendingEdit: null,
        scenarioSaveProposal: null,
        run: {
          state: "complete",
          endSeconds: 480,
          lateBatches: 0,
          unfinishedBatches: 0,
        },
      },
    });
    const response = await handlePortalChat(
      new Request("https://portal.example/chat", {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          conversationId: requireConversationId(
            "conv_c71a2ce0-733a-56e0-b371-371fe033b203",
          ),
          requestId: "request_surface_tampered",
          model: "test-model",
          text: "What is selected?",
          surfaceContext: { ...surfaceContext, digest: "0".repeat(64) },
        }),
      }),
      env,
      scope.organisationId,
    );

    expect(response.status).toBe(422);
    expect(
      await readConversation(
        env.DB,
        scope,
        "conv_c71a2ce0-733a-56e0-b371-371fe033b203",
      ),
    ).toBeNull();
  });

  it("lists subscription models and applies a new selection to the next turn", async function changesModel() {
    mocks.model.mockResolvedValue({
      ok: true,
      value: {
        keySource: "organisation_subscription",
        provider: "openai",
        model: "gpt-5.6-luna",
        connectionRevision: 3,
        authProfileGeneration: 2,
      },
    });
    const page = await handlePortalChat(
      new Request(
        "https://portal.example/v1/control/organisations/organisation_chat_test/chat",
      ),
      env,
      scope.organisationId,
    );
    expect(await page.json()).toMatchObject({
      model: {
        kind: "ready",
        selected: "gpt-5.6-luna",
        options: expect.arrayContaining([
          expect.objectContaining({ id: "gpt-6-astra" }),
          expect.objectContaining({ id: "gpt-5.6-luna" }),
        ]),
      },
    });
    mocks.generate
      .mockResolvedValueOnce(completed({ kind: "reply", text: "First" }))
      .mockResolvedValueOnce(completed({ kind: "reply", text: "Second" }));
    expect(
      (
        await handlePortalChat(
          request("First", "request_chat_first", "gpt-5.6-luna"),
          env,
          scope.organisationId,
        )
      ).status,
    ).toBe(200);
    const response = await handlePortalChat(
      request("Second", "request_chat_second", "gpt-6-astra"),
      env,
      scope.organisationId,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversation: { model: "gpt-6-astra" },
    });
  });

  it("retains a question card across reload, accepts its answer once, and continues to documentation and a connector in the same Case", async function conversationJourney() {
    const question = {
      title: "Which app would you like to connect?",
      description: "Choose your shipping provider.",
      options: [
        {
          id: "easypost",
          label: "EasyPost",
          description: "Read shipment status",
        },
      ],
      allowCustom: true,
    };
    mocks.generate.mockResolvedValueOnce(
      completed({ kind: "question", question }),
    );
    const first = await handlePortalChat(
      request("Connect an app"),
      env,
      scope.organisationId,
    );
    expect(first.status).toBe(200);
    const reloaded = await (await readResponse()).json();
    expect(reloaded).toMatchObject({
      conversation: {
        work: { kind: "ready" },
        timeline: expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", question }),
        ]),
        messages: [
          { kind: "user", text: "Connect an app" },
          {
            kind: "assistant",
            text: `${question.title}\n\n${question.description}`,
          },
        ],
      },
    });
    const document: unknown = JSON.parse(
      readFileSync(
        new NodeUrl(
          "./fixtures/custom-connectors/easypost-rest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    mocks.generate.mockResolvedValueOnce(
      completed({
        kind: "read_documentation",
        url: "https://docs.easypost.com/llms.txt",
      }),
    );
    mocks.documentation.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          url: "https://docs.easypost.com/llms.txt",
          sha256: "b".repeat(64),
          text: "GET https://api.easypost.com/v2/users returns account identity. GET https://api.easypost.com/v2/shipments lists shipments.",
          truncated: false,
        },
      ],
    });
    mocks.generate.mockResolvedValueOnce(
      completed({ kind: "definition", document }),
    );
    const response = await handlePortalChat(
      request(
        "EasyPost. Read my shipments. Its docs are at https://docs.easypost.com/llms.txt",
        "request_chat_second",
      ),
      env,
      scope.organisationId,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversation: {
        work: { kind: "ready" },
        messages: expect.arrayContaining([
          {
            kind: "connector",
            id: expect.any(String),
            text: expect.any(String),
            document: expect.objectContaining({ name: "EasyPost" }),
            target: { kind: "new" },
          },
        ]),
      },
    });
    const calls = mocks.generate.mock.calls.length;
    expect(
      (
        await handlePortalChat(
          request(
            "EasyPost. Read my shipments. Its docs are at https://docs.easypost.com/llms.txt",
            "request_chat_second",
          ),
          env,
          scope.organisationId,
        )
      ).status,
    ).toBe(200);
    expect(mocks.generate).toHaveBeenCalledTimes(calls);
    expect(
      (
        await handlePortalChat(
          request("Different content", "request_chat_second"),
          env,
          scope.organisationId,
        )
      ).status,
    ).toBe(409);
  });

  it("persists response feedback through the conversation API and isolates other conversations", async function responseFeedbackJourney() {
    mocks.generate.mockResolvedValueOnce(
      completed({
        kind: "reply",
        text: "Your shipping connection is ready to configure.",
      }),
    );
    await handlePortalChat(
      request("Help with shipping"),
      env,
      scope.organisationId,
    );
    const loaded = await (
      await readResponse()
    ).json<{
      conversation: { timeline: { kind: string; eventId: string }[] };
    }>();
    const response = loaded.conversation.timeline.find(isAssistantResponse);
    if (response === undefined) throw new Error("Missing assistant response");
    for (const rating of ["good", "bad", null]) {
      const patch = new Request("https://portal.example/chat", {
        method: "PATCH",
        body: JSON.stringify({
          action: "rate_response",
          eventId: response.eventId,
          rating,
        }),
      });
      const saved = await handlePortalChatConversation(
        patch,
        env,
        scope.organisationId,
        requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
      );
      expect(saved.status).toBe(200);
      expect(await (await readResponse()).json()).toMatchObject({
        conversation: {
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventId: response.eventId, rating }),
          ]),
        },
      });
    }
    const missing = await handlePortalChatConversation(
      new Request("https://portal.example/chat", {
        method: "PATCH",
        body: JSON.stringify({
          action: "rate_response",
          eventId: response.eventId,
          rating: "good",
        }),
      }),
      env,
      scope.organisationId,
      "conv_badea0cd-dbef-552c-ab26-d1d27a6e19ff",
    );
    expect(missing.status).toBe(404);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("repairs a draft and pins a revision card to the existing connector head", async function reviseConnector() {
    const document: unknown = JSON.parse(
      readFileSync(
        new NodeUrl(
          "./fixtures/custom-connectors/easypost-rest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const prepared = await prepareCustomConnectorDraftDocument(document);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const draft = await createCustomConnectorDraft({
      db: env.DB,
      organisationId: scope.organisationId,
      createdByUserId: scope.userId,
      document: prepared.value,
      now: 1,
    });
    mocks.generate.mockResolvedValueOnce(
      completed({
        kind: "read_documentation",
        url: "https://docs.easypost.com/llms.txt",
      }),
    );
    mocks.documentation.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          url: "https://docs.easypost.com/llms.txt",
          sha256: "b".repeat(64),
          text: "Read https://api.easypost.com/v2/users and /v2/shipments",
          truncated: false,
        },
      ],
    });
    mocks.generate.mockResolvedValueOnce(
      completed({
        kind: "revise",
        connectorId: draft.connectorId,
        document: {},
      }),
    );
    mocks.generate.mockResolvedValueOnce(
      completed({ kind: "revise", connectorId: draft.connectorId, document }),
    );
    const response = await handlePortalChat(
      request(
        "Fix my EasyPost connector. Its docs are at https://docs.easypost.com/llms.txt",
      ),
      env,
      scope.organisationId,
    );
    expect(await response.json()).toMatchObject({
      conversation: {
        work: { kind: "ready" },
        messages: expect.arrayContaining([
          expect.objectContaining({
            kind: "connector",
            target: {
              kind: "revision",
              connectorId: draft.connectorId,
              expectedHeadRevision: 1,
            },
          }),
        ]),
      },
    });
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM custom_connector_revision")
        .get(),
    ).toMatchObject({ count: 1 });
  });

  it("keeps history private and refuses a changed model instead of switching inference authority", async function privatePinnedConversation() {
    mocks.generate.mockResolvedValueOnce(
      completed({ kind: "reply", text: "Private answer" }),
    );
    await handlePortalChat(request("Hello"), env, scope.organisationId);
    const otherIdentity = parseUserId(
      "user_e4a94ea0-3192-559f-aecb-9eb74919fb94",
    );
    if (!otherIdentity.ok) throw new Error("Invalid fixture identity");
    expect(
      await readConversation(
        env.DB,
        { organisationId: scope.organisationId, userId: otherIdentity.value },
        requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
      ),
    ).toBeNull();
    mocks.model.mockResolvedValueOnce({
      ok: true,
      value: {
        keySource: "platform",
        provider: "openai-compatible",
        model: "other-model",
      },
    });
    expect(
      (
        await handlePortalChat(
          request("Continue", "request_chat_second"),
          env,
          scope.organisationId,
        )
      ).status,
    ).toBe(409);
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it("preserves an interrupted response for retry and fences concurrent updates", async function retryTurn() {
    mocks.generate.mockResolvedValueOnce({
      ok: false,
      error: { code: "conversation_turn_failed" },
    });
    await handlePortalChat(
      request("Connect my shipping app"),
      env,
      scope.organisationId,
    );
    const stored = await readConversation(
      env.DB,
      scope,
      "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    );
    if (stored === null) throw new Error("Conversation missing");
    expect(stored.conversation.work).toMatchObject({
      kind: "failed",
      requestId: "request_chat_first",
    });
    expect(
      await saveConversation(
        await requireOrganisationExecutionScope(env, scope.organisationId),
        scope.userId,
        stored.conversation,
        stored.revision - 1,
      ),
    ).toEqual({ kind: "conflict" });
    mocks.generate.mockResolvedValueOnce(
      completed({ kind: "reply", text: "Which service do you use?" }),
    );
    const retry = new Request("https://portal.example/chat", {
      method: "POST",
      body: JSON.stringify({
        kind: "retry",
        conversationId: requireConversationId(
          "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
        ),
        requestId: "request_chat_first",
        model: "test-model",
      }),
    });
    expect(
      (await handlePortalChat(retry, env, scope.organisationId)).status,
    ).toBe(200);
    const resumed = await readConversation(
      env.DB,
      scope,
      "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    );
    expect(
      (resumed
        ? timelineVisibleMessages(resumed.conversation)
        : undefined
      )?.filter(isUser),
    ).toHaveLength(1);
    expect(resumed?.conversation.work.kind).toBe("ready");
  });

  it("requires the connected model and rechecks membership before publishing a reply", async function reauthorization() {
    mocks.model.mockResolvedValueOnce({
      ok: false,
      error: { code: "organisation_openai_api_key_unavailable" },
    });
    expect(
      (await handlePortalChat(request("Hello"), env, scope.organisationId))
        .status,
    ).toBe(409);
    expect(mocks.generate).not.toHaveBeenCalled();
    mocks.generate.mockImplementationOnce(
      async function saveDraftBeforeRevocation() {
        const draft = await updateConversationDraft(
          execution,
          scope.userId,
          requireConversationId("conv_7d980f41-a532-5387-9ea1-548f956b6e3e"),
          "Keep this draft after access changes",
          null,
          Date.now(),
        );
        expect(draft.ok).toBe(true);
        await env.DB.prepare(
          "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
        )
          .bind(scope.organisationId, scope.userId)
          .run();
        return completed({ kind: "reply", text: "Private reply" });
      },
    );
    expect(
      (await handlePortalChat(request("Hello"), env, scope.organisationId))
        .status,
    ).toBe(404);
    const stored = await readConversation(
      env.DB,
      scope,
      "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
    );
    expect(
      JSON.stringify(
        stored ? timelineVisibleMessages(stored.conversation) : undefined,
      ),
    ).not.toContain("Private reply");
    expect(stored?.conversation).toMatchObject({
      draftText: "Keep this draft after access changes",
      work: { kind: "failed", requestId: "request_chat_first" },
    });
    expect(stored?.conversation.timeline.at(-1)).toMatchObject({
      kind: "run_failed",
      requestId: "request_chat_first",
    });
  });

  it("rejects unsafe discovery requests and keeps recognizable API keys out of stored chat", async function credentialBoundary() {
    expect(
      parseChatModelAction(
        '{"kind":"read_documentation","url":"https://user:secret@example.com/docs"}',
      ).ok,
    ).toBe(false);
    expect(
      parseChatCommand({
        kind: "message",
        conversationId: requireConversationId(
          "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
        ),
        requestId: "request_chat_first",
        model: "test-model",
        text: "sk-proj-abcdefghijklmnopqrstuvwxy",
      }).ok,
    ).toBe(false);
    expect(
      (
        await handlePortalChat(
          request("sk-proj-abcdefghijklmnopqrstuvwxy"),
          env,
          scope.organisationId,
        )
      ).status,
    ).toBe(422);
    expect(
      await readConversation(
        env.DB,
        scope,
        "conv_7d980f41-a532-5387-9ea1-548f956b6e3e",
      ),
    ).toBeNull();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>(function captureResolve(resolve) {
    resolvePromise = resolve;
  });
  if (resolvePromise === null) throw new Error("Deferred promise unavailable");
  return { promise, resolve: resolvePromise };
}
function isUser(message: { readonly kind: string }): boolean {
  return message.kind === "user";
}
function eventIsCancellation(event: { readonly kind: string }): boolean {
  return event.kind === "run_cancelled";
}

function generatedTurnCount(): number {
  return mocks.generate.mock.calls.length;
}
