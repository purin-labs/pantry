import { ensureOrganisationDefaultWorkspace } from "../../services/platform/src/data/organisation-workspace";
import { seedCanvasAcceptance } from "../bakery-canvas-acceptance/fixture";
import { prepareReadAndProposeAccessDefaults } from "../../services/platform/src/data/capability-policy";
import { compilePublishAndActivateOrganisationPolicy } from "../../services/platform/src/policy-snapshot";
import { requireActiveOrganisationActor } from "../../services/platform/src/actors/actor-router";
import { resolveActiveCaseActor } from "../../services/platform/src/actors/actor-router";
import { deriveDirectCaseIdentities } from "../../services/platform/src/actors/case-direct-processing";
import { conversationCaseIdentity } from "../../services/platform/src/chat/conversation-access";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope";
import { ensureInitialOrganisationPlacement } from "../../services/platform/src/data/shared-rows/placement-row";
import { parseOrganisationPlacementProfile } from "../../services/platform/src/placement";
import { canonicalJson, sha256Hex } from "../../packages/std/src/index";
import gateway from "../../services/platform/src/integration-gateway";
import {
  issueControlSession,
  upsertUser,
} from "../../services/platform/src/data/control-plane";
import type { Env } from "../../services/platform/src/env";
import {
  parseCaseId,
  parseOrganisationId,
} from "../../services/platform/src/ids";
import {
  baseProjectId,
  prepareBaseProject,
  prepareBaseProjectMembership,
} from "../../services/platform/src/projects/default-project";
import { ensureCaseProject } from "../../services/platform/src/projects/case-project";
import {
  readConversation,
  saveConversation,
  updateConversationMetadata,
} from "../../services/platform/src/chat/store";
import type { Conversation } from "../../services/platform/src/chat/conversation";
import type { PendingChatInput } from "../../services/platform/src/chat/timeline";
import { PACKAGED_PI_MODEL } from "../../services/platform/src/actors/pi-model-transport";
import {
  newProjectId,
  newConversationId,
  isConversationId,
  parseConversationId,
  type ConversationId,
} from "../../packages/control-api/src/ids";

export {
  OrganisationDO,
  SessionDO,
  CaseDO,
  ConnectorDO,
  CodeModePlatformGovernorActor,
} from "../../services/platform/src/integration-gateway";

const organisationId = fixtureOrganisationId("organisation_chat_preview");
const foreignOrganisationId = fixtureOrganisationId(
  "organisation_plan54_foreign",
);
const names = ["Owner", "Editor", "Viewer", "Unrelated", "Foreign"] as const;

// This fixture is a separate local Worker. All /v1 requests use production routing.
export default {
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return gateway.queue(batch, env);
  },
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (request.method === "OPTIONS")
      response = new Response(null, { status: 204 });
    else if (url.pathname === "/test/health")
      response = new Response(null, { status: 204 });
    else if (url.pathname === "/test/setup" && request.method === "POST") {
      response = await seed(env, url.searchParams.get("base") === "members");
      if (url.searchParams.get("canvas") === "1")
        response = Response.json(
          await seedCanvasAcceptance(env, await response.json()),
        );
    } else if (url.pathname === "/test/session" && request.method === "POST")
      response = await login(env, url.searchParams.get("user"));
    else if (url.pathname === "/test/queue" && request.method === "POST")
      response = await seedQueue(env, url.searchParams.get("conversation"));
    else if (url.pathname === "/test/pagination" && request.method === "POST")
      response = await seedPagination(env, url.searchParams.get("lifecycle"));
    else if (url.pathname === "/test/source-case" && request.method === "POST")
      response = await seedSourceCase(env, url.searchParams.get("origin"));
    else response = await gateway.fetch(request, env, context);
    if (response.status === 101) return response;
    response = new Response(response.body, response);
    response.headers.set(
      "access-control-allow-origin",
      env.SATYR_PUBLIC_ORIGIN ?? "http://127.0.0.1:3116",
    );
    response.headers.set("access-control-allow-credentials", "true");
    response.headers.set(
      "access-control-allow-headers",
      "content-type,x-satyr-csrf",
    );
    response.headers.set(
      "access-control-allow-methods",
      "GET,PATCH,POST,PUT,DELETE,OPTIONS",
    );
    return response;
  },
};

async function login(env: Env, name: string | null): Promise<Response> {
  if (name === null || !names.some(hasName.bind(null, name)))
    return new Response(null, { status: 400 });
  const user = await fixtureUser(env, name);
  const issued = await issueControlSession({
    db: env.DB,
    userId: user.userId,
    now: Date.now(),
    ttlMs: 3600000,
  });
  const response = Response.json({ userId: user.userId });
  response.headers.append(
    "set-cookie",
    `satyr_control_session=${issued.token}; HttpOnly; Path=/; SameSite=Lax`,
  );
  response.headers.append(
    "set-cookie",
    `satyr_control_csrf=${issued.csrfToken}; Path=/; SameSite=Lax`,
  );
  return response;
}

function hasName(name: string | null, candidate: string): boolean {
  return name === candidate;
}

function fixtureOrganisationId(raw: string) {
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) throw new Error("Invalid fixture organisation");
  return parsed.value;
}

async function fixtureUser(env: Env, name: string) {
  return upsertUser({
    db: env.DB,
    now: Date.now(),
    identity: {
      issuer: "urn:satyr:plan54-browser",
      subject: name,
      email: `${name.toLowerCase()}@example.test`,
      displayName: name,
      emailVerified: true,
    },
  });
}

async function seed(env: Env, joinBase: boolean): Promise<Response> {
  const now = Date.now();
  for (const id of [organisationId, foreignOrganisationId]) {
    await env.DB.prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'Browser acceptance', ?)",
    )
      .bind(id, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO organisation_onboarding
      (organisation_id, environment, lifecycle, capability_profile, configuration_version, projection_revision, activation_receipt_id, activated_at, updated_at)
      VALUES (?, 'development', 'active', 'read_and_propose', 1, 1, 'receipt_browser', ?, ?)`,
    )
      .bind(id, now, now)
      .run();
    // Provisioning gives every Organisation a default Project. It starts with
    // no member: the fixture's users read nothing from it unless they join below.
    await env.DB.batch(
      prepareBaseProject(env.DB, {
        organisationId: id,
        projectId: await baseProjectId(id),
        ownerUserId: null,
        now,
      }),
    );
  }
  const profile = parseOrganisationPlacementProfile(
    env.SATYR_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!profile.ok) throw new Error(profile.error.code);
  for (const id of [organisationId, foreignOrganisationId]) {
    const placement = await ensureInitialOrganisationPlacement({
      db: env.DB,
      organisationId: id,
      placement: profile.value,
      environment: "development",
      now,
    });
    if (!placement.ok) throw new Error(placement.error.code);
  }
  const users = [];
  for (const name of names) {
    const user = await fixtureUser(env, name);
    const id = name === "Foreign" ? foreignOrganisationId : organisationId;
    const personId = `person_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      ).bind(id, personId, name),
      env.DB.prepare(
        "INSERT INTO organisation_membership (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      ).bind(id, user.userId, personId, now),
    ]);
    users.push({ name, userId: user.userId });
    // Joining an Organisation joins its default Project. Unrelated stays out,
    // as a member does who joined after the Project held shared work.
    if (
      joinBase &&
      (name === "Owner" || name === "Editor" || name === "Viewer")
    )
      await env.DB.batch(
        prepareBaseProjectMembership(env.DB, {
          organisationId: id,
          userId: user.userId,
          role: "admin",
          now,
        }),
      );
  }
  const owner = users.find(hasFixtureName.bind(null, "Owner"));
  if (owner === undefined) throw new Error("Owner fixture missing");
  for (const id of [organisationId, foreignOrganisationId])
    await env.DB.prepare(
      "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
    )
      .bind(id, owner.userId, now)
      .run();
  await env.DB.batch([
    ...prepareReadAndProposeAccessDefaults({
      source: env.DB,
      admission: {
        kind: "organisation_execution",
        scope: await fixtureExecution(env),
      },
      materializationReceiptId: "receipt_browser",
      destination: { kind: "organisation" },
      now,
    }),
  ]);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Browser acceptance",
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: env.DB, kv: env.POLICY_KV },
    organisationId,
    organisation,
    now,
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const projectId = newProjectId();
  await env.DB.prepare(
    `INSERT INTO project
    (organisation_id, user_id, project_id, name, brief, references_json, revision, content_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'Launch team', 'Plan the autumn launch.', '[]', 1, 1, ?, ?)`,
  )
    .bind(organisationId, owner.userId, projectId, now, now)
    .run();
  const sharedCandidate = newConversationId();
  const privateChat = newConversationId();
  const deniedChat = newConversationId();
  for (const [id, title] of [
    [sharedCandidate, "Launch checklist"],
    [privateChat, "Private supplier negotiation"],
    [deniedChat, "Restricted history"],
  ] as const) {
    const saved = await saveConversation(
      await fixtureExecution(env),
      owner.userId,
      emptyConversation(id, title),
      0,
      { projectId },
    );
    if (saved.kind !== "saved")
      throw new Error("Conversation fixture could not be saved");
  }
  const identities = await deriveDirectCaseIdentities(
    await conversationCaseIdentity(
      env.DB,
      { organisationId, userId: owner.userId },
      sharedCandidate,
    ),
  );
  if (!identities.ok) throw new Error(identities.error.code);
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId,
    caseId: identities.value.caseId,
    now,
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const workspace = await ensureOrganisationDefaultWorkspace({
    scope: await fixtureExecution(env),
    archive: env.ARCHIVE,
    now,
  });
  if (!workspace.ok) throw new Error(workspace.error.code);
  const ensured = await caseActor.value.ensure({
    identity: { organisationId, caseId: identities.value.caseId },
    purpose: "Launch checklist",
    workspaceRevision: workspace.value.revision,
    lifecycle: { kind: "open", openedAt: now },
  });
  if (!ensured.ok) throw new Error(ensured.error.code);
  const oldLayer = {
    kind: "project",
    projectId,
    membershipRevision: 1,
    contentRevision: 1,
    name: "Hidden P54B supplier",
    brief: "Retained confidential supplier terms.",
    references: [],
  };
  const snapshot = {
    layer: oldLayer,
    observedAt: now,
    digest: await sha256Hex(
      canonicalJson({ layer: oldLayer, observedAt: now }),
    ),
  };
  const timeline = [
    {
      kind: "user",
      eventId: "historical_p54b",
      requestId: "historical_p54b",
      sequence: 1,
      createdAt: now,
      text: "Retained private request.",
      parts: [
        { kind: "text", text: "Retained private request." },
        { kind: "project_context", snapshot },
      ],
    },
  ];
  await env.DB.prepare(
    "UPDATE portal_conversation SET state_json = json_set(state_json, '$.timeline', json(?), '$.latestSequence', 1), latest_sequence = 1 WHERE organisation_id = ? AND conversation_id = ?",
  )
    .bind(JSON.stringify(timeline), organisationId, deniedChat)
    .run();
  return Response.json({
    organisationId,
    foreignOrganisationId,
    defaultProjectId: await baseProjectId(organisationId),
    users,
    projectId,
    sharedCandidate,
    privateChat,
    deniedChat,
  });
}

// Files a Case the way a source admits one: in the Organisation's default
// Project, with no chat to present it.
async function seedSourceCase(
  env: Env,
  origin: string | null,
): Promise<Response> {
  if (origin !== "slack" && origin !== "email" && origin !== "whatsapp")
    return new Response(null, { status: 400 });
  const caseId = parseCaseId(`case_${crypto.randomUUID().replaceAll("-", "")}`);
  if (!caseId.ok) throw new Error(caseId.error.code);
  const placed = await ensureCaseProject({
    scope: await fixtureExecution(env),
    caseId: caseId.value,
    origin,
    now: Date.now(),
  });
  if (!placed.ok) throw new Error(placed.error.code);
  return Response.json({
    caseId: caseId.value,
    projectId: placed.value.projectId,
    revision: placed.value.revision,
  });
}

function hasFixtureName(name: string, user: { name: string }): boolean {
  return user.name === name;
}

async function seedQueue(env: Env, rawId: string | null): Promise<Response> {
  if (!isConversationId(rawId)) return new Response(null, { status: 400 });
  const owner = await fixtureUser(env, "Owner");
  const scope = { organisationId, userId: owner.userId };
  const stored = await readConversation(env.DB, scope, rawId);
  if (
    stored === null ||
    stored.conversation.work.kind !== "ready" ||
    stored.conversation.timeline.length !== 0
  )
    return new Response(null, { status: 409 });
  const inputs: PendingChatInput[] = [
    queuedInput("Withdraw this queued message"),
    queuedInput("Shared queue must stay hidden after access changes"),
  ];
  const saved = await saveConversation(
    await fixtureExecution(env),
    owner.userId,
    emptyConversation(rawId, stored.conversation.title, inputs),
    stored.revision,
  );
  if (saved.kind !== "saved") return new Response(null, { status: 409 });
  return new Response(null, { status: 204 });
}

function queuedInput(text: string): PendingChatInput {
  return {
    inputId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    mode: "next",
    parts: [{ kind: "text", text }],
    acceptedAt: Date.now(),
  };
}

async function seedPagination(
  env: Env,
  lifecycle: string | null,
): Promise<Response> {
  if (lifecycle !== "active" && lifecycle !== "archived")
    return new Response(null, { status: 400 });
  const owner = await fixtureUser(env, "Owner");
  const scope = { organisationId, userId: owner.userId };
  const offset = lifecycle === "active" ? 100 : 200;
  for (let index = 0; index < 61; index++) {
    const parsed = parseConversationId(
      `conv_00000000-0000-4000-8000-${(offset + index).toString(16).padStart(12, "0")}`,
    );
    if (!parsed.ok) throw new Error("Invalid pagination fixture ID");
    const saved = await saveConversation(
      await fixtureExecution(env),
      scope.userId,
      emptyConversation(
        parsed.value,
        `${lifecycle} pagination chat ${index + 1}`,
      ),
      0,
    );
    if (saved.kind !== "saved")
      throw new Error("Pagination fixture could not be saved");
    if (lifecycle === "archived") {
      const archived = await updateConversationMetadata(
        await fixtureExecution(env),
        scope.userId,
        parsed.value,
        { kind: "archive", expectedRevision: 1 },
        Date.now(),
      );
      if (!archived.ok)
        throw new Error("Pagination fixture could not be archived");
    }
  }
  return new Response(null, { status: 204 });
}

function emptyConversation(
  id: ConversationId,
  title: string,
  pendingInputs: readonly PendingChatInput[] = [],
): Conversation {
  return {
    id,
    title,
    lineage: { kind: "original" },
    historyBindings: [],
    modelRoute: {
      keySource: "platform",
      provider: "openai-compatible",
      model: PACKAGED_PI_MODEL,
    },
    documents: [],
    work: { kind: "ready" },
    completedRequests: [],
    timeline: [],
    pendingInputs,
    latestSequence: 0,
    lastReadSequence: 0,
    surfaceEventCursor: 0,
    draftText: "",
    draftUpdatedAt: null,
    effort: null,
  };
}

async function fixtureExecution(env: Env): Promise<OrganisationExecutionScope> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok) throw new Error(execution.error.code);
  return execution.value;
}
