import { OrganisationExecutionScope } from "../../foundation/tenancy/organisation-execution-scope.ts";
import {
  saveConversation,
  readConversation,
} from "../../services/platform/src/chat/store.ts";
import {
  canProjectAgentEvent,
  projectAcceptedTurnReplay,
  createPortalChatStreamResponse,
} from "../../services/platform/src/chat/portal-stream.ts";
import { createSessionReplayResponse } from "../../services/platform/src/actors/session/replay.ts";
import { readChatControlAuthority } from "../../services/platform/src/chat/information-flow.ts";
import {
  createAccessGrant,
  readAccessGrant,
} from "../../foundation/authority/data/access-grants.ts";
import { readSessionTurnFlowBinding } from "../../services/platform/src/actors/agent-session-information-flow.ts";
import {
  readLatestHarnessCheckpoint,
  readHarnessHistory,
} from "../../services/platform/src/actors/agent-session-harness-authority.ts";
import {
  parseChatModelAction,
  isChatId,
  normalizeConversationTimeline,
} from "../../services/platform/src/chat/conversation.ts";
import { buildAssistantTimelineEvent } from "../../services/platform/src/chat/timeline.ts";
import { organisationId, userId } from "./proposal-worker.mjs";
import { authorizeConversation } from "../../services/platform/src/chat/conversation-access.ts";
import { parseUserId } from "../../packages/control-api/src/ids.ts";
import { mutateProject } from "../../services/platform/src/projects/commands.ts";
import { mutateProjectAccess } from "../../services/platform/src/projects/membership.ts";
import { shareConversation } from "../../services/platform/src/chat/conversation-sharing.ts";
import { listProjectMembers } from "../../services/platform/src/projects/access.ts";
import { issueControlSession } from "../../foundation/tenancy/data/control-plane.ts";

export const conversationId = "conv_aaaaaaaa-1111-4111-8111-111111111111";
export const contributorId = "user_22222222-2222-5222-8222-222222222222";
const sharedProjectId = "project_aaaaaaaa-1111-4111-8111-111111111111";
const grants = [
  "grant_native_offer_read",
  "grant_native_mcp_custom_connector_operation",
];

// The account check of an observation asks for the observer's own live
// control session, as a Portal page has one.
const observerSessions = new Map();
async function observerSessionId(db, observerId) {
  let id = observerSessions.get(observerId);
  if (id === undefined) {
    const issued = await issueControlSession({
      db,
      userId: observerId,
      now: Date.now(),
      ttlMs: 3_600_000,
    });
    id = issued.session.controlSessionId;
    observerSessions.set(observerId, id);
  }
  return id;
}

function required(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function installPortalAuthority(env, shared) {
  const db = env.DB;
  if (shared) {
    await db
      .prepare(
        "UPDATE service_role_grant SET role = 'owner' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(organisationId, contributorId)
      .run();
  }
  const reader = shared
    ? { kind: "organisation_role", role: "owner" }
    : { kind: "person", personId: `person_${userId}` };
  await grantPortalAccess(db, reader, "observer", grants);
  await grantPortalAccess(
    db,
    { kind: "person", personId: `person_${userId}` },
    "observer",
    [
      "grant_native_proposal",
      "grant_native_proposal_tool",
      "grant_native_mcp_platform_capability",
    ],
  );
  const authority = await readChatControlAuthority(db, {
    organisationId,
    userId,
  });
  if (authority === null) throw new Error("Missing operator authority");
  return authority;
}

async function grantPortalAccess(db, subject, suffix, grantIds) {
  for (const grantId of grantIds) {
    const grant = required(
      await readAccessGrant({ db, organisationId, grantId }),
    );
    required(
      await createAccessGrant({
        db,
        organisationId,
        grantId: `${grantId}_${suffix}`,
        target: grant.target,
        subject,
        provenance: {
          kind: "operator",
          userId,
          mutationReceiptId: "native_observer_grant",
        },
        now: Date.now(),
      }),
    );
  }
}

function accepted(result) {
  if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
  return result;
}

export async function sharePortalTrial(actor) {
  await preparePortalObservation(actor);
  const execution = required(
    await OrganisationExecutionScope.resolve(actor.env, organisationId),
  );
  accepted(
    await mutateProject(
      actor.env,
      execution,
      { userId, organisationRole: "owner" },
      {
        kind: "create_project",
        operationId: "native_shared_project",
        projectId: sharedProjectId,
        content: { name: "Native shared execution", brief: "", references: [] },
      },
      Date.now(),
    ),
  );
  const access = accepted(
    await mutateProjectAccess(actor.env, execution, userId, sharedProjectId, {
      kind: "share_project",
      operationId: "native_shared_access",
      expectedAccessRevision: 0,
      members: [{ userId: contributorId, role: "viewer" }],
    }),
  );
  const stored = await readPortalConversation(actor);
  accepted(
    await shareConversation(actor.env, execution, userId, conversationId, {
      kind: "share_conversation",
      operationId: "native_shared_conversation",
      projectId: sharedProjectId,
      expectedRevision: stored.revision,
      expectedProjectAccessRevision: access.accessRevision,
    }),
  );
  await requirePortalAudienceAccess(
    actor,
    await preparePortalObservation(actor),
  );
  return { accessRevision: access.accessRevision, contributorId };
}

export async function setPortalContributorRole(
  actor,
  role,
  expectedAccessRevision,
) {
  const execution = required(
    await OrganisationExecutionScope.resolve(actor.env, organisationId),
  );
  return accepted(
    await mutateProjectAccess(actor.env, execution, userId, sharedProjectId, {
      kind: "set_project_member",
      operationId: `native_contributor_${role}_${expectedAccessRevision}`,
      expectedAccessRevision,
      userId: contributorId,
      role,
    }),
  );
}

export async function preparePortalObservation(actor) {
  const db = actor.env.DB;
  const scope = { organisationId, userId };
  const placement = required(
    await OrganisationExecutionScope.resolve(actor.env, organisationId),
  );
  const saved = await saveConversation(
    placement,
    userId,
    {
      id: conversationId,
      title: "Native execution trial",
      lineage: { kind: "original" },
      historyBindings: [],
      modelRoute: actor.lifecycle().state.contract.modelRoute,
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
    },
    0,
  );
  if (saved.kind !== "saved" && saved.kind !== "conflict")
    throw new Error(JSON.stringify(saved));
  const requestAuthority = await readChatControlAuthority(db, scope);
  if (requestAuthority === null) throw new Error("Missing observer authority");
  const current = actor.lifecycle();
  const sessionId = current.state.identity.sessionId;
  const control = actor.inputControl();
  let turnId;
  if (control?.command.kind === "cancel") {
    turnId = control.command.lease.turn.turnId;
  } else if (current.kind === "sleeping" || current.kind === "checkpointing") {
    turnId = required(
      readLatestHarnessCheckpoint(actor.ctx.storage.sql, sessionId),
    ).turn.turnId;
  } else {
    turnId = actor.currentLease().turn.turnId;
  }
  return {
    input: {
      env: actor.env,
      placement,
      scope,
      conversationId,
      requestAuthority,
      controlSessionId: await observerSessionId(db, userId),
    },
    stream: { sessionId, turnId },
    session: { readSessionTurnFlowBinding: readBinding.bind(null, actor) },
  };
}

export function canObservePortal(observation) {
  return canProjectAgentEvent(
    observation.input,
    observation.stream,
    observation.session,
  );
}

export async function authorizePortalInput(actor, request) {
  const requester = parseUserId(
    request.headers.get("x-trial-user-id") ?? userId,
  );
  if (!requester.ok) return { kind: "denied" };
  await preparePortalObservation(actor);
  const scope = { organisationId, userId: requester.value };
  const access = await authorizeConversation(
    actor.env.DB,
    scope,
    conversationId,
  );
  if (access === null || access.role === "viewer") return { kind: "denied" };
  const authority = await readChatControlAuthority(actor.env.DB, scope);
  if (authority === null) return { kind: "denied" };
  return { kind: "authorized", requester: authority };
}

export async function authorizePortalObservation(actor, request) {
  const turnId = new URL(request.url).searchParams.get("turn");
  if (!isChatId(turnId)) return new Response("Invalid turn.", { status: 400 });
  const requester = parseUserId(
    request.headers.get("x-trial-user-id") ?? userId,
  );
  if (!requester.ok)
    return new Response("Conversation unavailable.", { status: 403 });
  const base = await preparePortalObservation(actor);
  const scope = { organisationId, userId: requester.value };
  const requestAuthority = await readChatControlAuthority(actor.env.DB, scope);
  if (requestAuthority === null)
    return new Response("Conversation unavailable.", { status: 403 });
  const observation = {
    input: {
      env: actor.env,
      placement: base.input.placement,
      scope,
      conversationId,
      requestAuthority,
      controlSessionId: await observerSessionId(actor.env.DB, requester.value),
    },
    stream: { sessionId: base.stream.sessionId, turnId },
    session: base.session,
  };
  if (!(await canObservePortal(observation)))
    return new Response("Conversation unavailable.", { status: 403 });
  return observation;
}

export async function createPortalReplay(actor, afterSequence, request) {
  const observation = await authorizePortalObservation(actor, request);
  if (observation instanceof Response) return observation;
  const response = required(
    createSessionReplayResponse(
      { sql: actor.ctx.storage.sql, durableState: actor.ctx },
      { organisationId, turnId: observation.stream.turnId, afterSequence: -1 },
    ),
  );
  const output = new TransformStream();
  const writer = output.writable.getWriter();
  const projection = projectAcceptedTurnReplay(
    {
      ...observation.input,
      placement: required(
        await OrganisationExecutionScope.resolve(actor.env, organisationId),
      ),
      requestId: "native_portal_trial",
      afterSequence,
    },
    writer,
    { ...observation.stream, step: 0 },
    { response, session: observation.session },
  );
  actor.ctx.waitUntil(closeProjection(projection, writer));
  return new Response(output.readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

export async function completePortalConversation(actor) {
  const lifecycle = actor.lifecycle();
  if (lifecycle.kind !== "sleeping" && lifecycle.kind !== "checkpointing")
    throw new Error("Portal completion requires an accepted checkpoint");
  const observation = await preparePortalObservation(actor);
  const history = required(
    await readHarnessHistory(
      actor.ctx.storage.sql,
      observation.stream.sessionId,
      organisationId,
    ),
  );
  if (history.kind !== "bounded_history")
    throw new Error("Missing Portal history");
  for (let index = 0; index < history.history.entries.length; index += 1) {
    const entry = history.history.entries[index];
    if (entry.kind !== "assistant_message" || entry.stopReason !== "completed")
      continue;
    await completePortalTurn(
      actor,
      {
        input: observation.input,
        stream: {
          sessionId: observation.stream.sessionId,
          turnId: entry.turn.turnId,
        },
        session: observation.session,
      },
      index + 1,
    );
  }
  return readPortalConversation(actor);
}

export async function readPortalConversation(actor) {
  const stored = await readConversation(
    actor.env.DB,
    { organisationId, userId },
    conversationId,
  );
  if (stored === null) throw new Error("Missing Portal conversation");
  return stored;
}

async function completePortalTurn(actor, observation, throughSequence) {
  await requirePortalAudienceAccess(actor, observation);
  const { sessionId, turnId } = observation.stream;
  const stored = await readConversation(
    actor.env.DB,
    observation.input.scope,
    conversationId,
  );
  if (stored === null) throw new Error("Missing Portal conversation");
  if (stored.conversation.completedRequests.includes(turnId)) return stored;
  const materialized = required(
    await readHarnessHistory(
      actor.ctx.storage.sql,
      sessionId,
      organisationId,
      throughSequence,
    ),
  );
  if (
    materialized.kind !== "bounded_history" ||
    materialized.history.cursor === null
  )
    throw new Error("Missing accepted Portal history");
  const entry = materialized.history.entries.at(-1);
  if (
    entry.kind !== "assistant_message" ||
    entry.stopReason !== "completed" ||
    entry.turn.turnId !== turnId
  )
    throw new Error(
      "Portal completion requires the accepted final assistant message",
    );
  const action = required(parseChatModelAction(entry.content[0].text));
  if (action.kind !== "reply" && action.kind !== "question")
    throw new Error("Native Portal trial requires a reply or question");
  const sequence = stored.conversation.latestSequence + 1;
  const eventId = `response_${turnId}`;
  const event = buildAssistantTimelineEvent({
    eventId,
    sequence,
    requestId: turnId,
    createdAt: entry.acceptedAt,
    text:
      action.kind === "reply"
        ? action.text
        : [action.question.title, action.question.description]
            .filter(Boolean)
            .join("\n\n"),
    ...(action.kind === "question" ? { question: action.question } : {}),
  });
  const conversation = normalizeConversationTimeline({
    id: stored.conversation.id,
    title: stored.conversation.title,
    lineage: stored.conversation.lineage,
    modelRoute: stored.conversation.modelRoute,
    documents: stored.conversation.documents,
    pendingInputs: stored.conversation.pendingInputs,
    latestSequence: stored.conversation.latestSequence,
    lastReadSequence: stored.conversation.lastReadSequence,
    surfaceEventCursor: stored.conversation.surfaceEventCursor,
    draftText: stored.conversation.draftText,
    draftUpdatedAt: stored.conversation.draftUpdatedAt,
    effort: stored.conversation.effort,
    work: { kind: "ready" },
    completedRequests: [...stored.conversation.completedRequests, turnId],
    timeline: [...stored.conversation.timeline, event],
    historyBindings: [
      ...stored.conversation.historyBindings,
      {
        requestId: turnId,
        responseId: eventId,
        throughSequence: sequence,
        sessionId,
        turnId,
        cursor: materialized.history.cursor,
        modelRoute: stored.conversation.modelRoute,
      },
    ],
  });
  const placement = required(
    await OrganisationExecutionScope.resolve(actor.env, organisationId),
  );
  const saved = await saveConversation(
    placement,
    userId,
    conversation,
    stored.revision,
  );
  if (saved.kind !== "saved")
    throw new Error(`Portal completion: ${saved.kind}`);
  const completed = await readConversation(
    actor.env.DB,
    observation.input.scope,
    conversationId,
  );
  if (completed === null)
    throw new Error("Saved Portal completion unavailable");
  return completed;
}

async function requirePortalAudienceAccess(actor, observation) {
  const access = await authorizeConversation(
    actor.env.DB,
    observation.input.scope,
    conversationId,
  );
  if (access === null) throw new Error("Portal conversation access denied");
  const members =
    access.access.kind === "private"
      ? [{ userId }]
      : await listProjectMembers(
          actor.env.DB,
          observation.input.scope,
          access.access.sharedProjectId,
        );
  if (members === null) throw new Error("Portal audience unavailable");
  for (const member of members) {
    const scope = { organisationId, userId: member.userId };
    const authority = await readChatControlAuthority(actor.env.DB, scope);
    if (
      authority === null ||
      !(await canProjectAgentEvent(
        {
          env: actor.env,
          placement: observation.input.placement,
          scope,
          conversationId,
          requestAuthority: authority,
          controlSessionId: await observerSessionId(
            actor.env.DB,
            member.userId,
          ),
        },
        observation.stream,
        observation.session,
      ))
    )
      throw new Error("Portal audience source access denied");
  }
}

export async function createPortalCompletionStream(actor) {
  const observation = await preparePortalObservation(actor);
  if (!(await canObservePortal(observation)))
    return new Response("Conversation unavailable.", { status: 403 });
  return createPortalChatStreamResponse(
    {
      ...observation.input,
      placement: required(
        await OrganisationExecutionScope.resolve(actor.env, organisationId),
      ),
      requestId: observation.stream.turnId,
      afterSequence: -1,
    },
    actor.ctx,
  );
}

async function closeProjection(projection, writer) {
  try {
    await projection;
    await writer.close();
  } catch (error) {
    await writer.abort(error);
  }
}

export async function canOtherMemberObserve(observation) {
  const scope = {
    organisationId,
    userId: "user_22222222-2222-5222-8222-222222222222",
  };
  const requestAuthority = await readChatControlAuthority(
    observation.input.env.DB,
    scope,
  );
  if (requestAuthority === null)
    throw new Error("Missing other member authority");
  return canProjectAgentEvent(
    {
      env: observation.input.env,
      placement: observation.input.placement,
      scope,
      conversationId,
      requestAuthority,
      controlSessionId: await observerSessionId(
        observation.input.env.DB,
        scope.userId,
      ),
    },
    observation.stream,
    observation.session,
  );
}

async function readBinding(actor, input) {
  const binding = required(
    await readSessionTurnFlowBinding(actor.ctx.storage.sql, {
      organisationId: input.requestingOrganisationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    }),
  );
  if (binding === null)
    return { ok: false, error: { code: "session_turn_not_found" } };
  return { ok: true, value: binding.binding.toJSON() };
}
