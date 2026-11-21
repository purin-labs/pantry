import type {
  DecidePendingDecision,
  PendingDecisionAnswer,
  PendingDecisionProof,
} from "../decide-pending-decision";
import {
  parseAgentPermissionDecision,
  type HeldOutputSummary,
  type HeldOutputView,
} from "@purin-labs/control-api";

import { authenticatedConversationScope } from "../../organisation-access/access";
import { resolveActiveCaseActorAtPlacement } from "../../actors/actor-router";
import { capabilityDefinitionById } from "../../authorization/capability-catalogue";
import { readChatControlAuthority } from "../../chat/information-flow";
import {
  decideHeldOutputRequest,
  HELD_OUTPUT_REQUEST_LIFETIME_MS,
  heldEffectCoversRequest,
  listPendingHeldOutputRequests,
  readHeldOutputRequest,
  type HeldOutputRequest,
} from "../../data/held-output-request";
import type { Env } from "../../env";
import { parseActiveCapabilityId } from "../../data/capability-policy";
import { parseCaseId } from "../../ids";
import { memberMaySee, type MemberViewer } from "../../chat/member-view";
import { FlowLabel } from "../../policy/information-flow";
import { policyLevel } from "../../policy/information-flow/labels";
import { slackSurfaceParts } from "../../slack/surface-parts";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  readDiscoveredResourceLabel,
  readSessionConversationId,
} from "../../data/held-output-context";

export type HeldOutputRequestRoute = Readonly<{
  kind: "heldOutputRequest";
  organisationIdRaw: string;
  requestId: string;
  transport: "view" | "decision";
}>;

export function matchHeldOutputRequestRoute(
  pathname: string,
): HeldOutputRequestRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/access-control\/held-outputs\/([0-9a-f]{32})(\/decision)?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    return {
      kind: "heldOutputRequest",
      organisationIdRaw: decodeURIComponent(match[1] ?? ""),
      requestId: match[2] ?? "",
      transport: match[3] === undefined ? "view" : "decision",
    };
  } catch {
    return null;
  }
}

/**
 * An answer that the exit check stopped (Plan 27C). Only a person who may
 * decide it reads it: for private content, a person in its audience; for
 * internal content that would leave the Organisation, the person who started
 * the work, or an owner or admin. To any other member it does not exist.
 */
export async function handleHeldOutputRequestRoute(
  request: Request,
  env: Env,
  route: HeldOutputRequestRoute,
  decide: DecidePendingDecision,
): Promise<Response> {
  if (route.transport === "view") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "viewer",
      false,
    );
    if (!authorized.ok) return authorized.response;
    const stored = await readDecidable(env, authorized, route.requestId);
    if (stored === null) return controlError("held_output_not_found", 404);
    const view = await heldOutputView(env, authorized, stored);
    return view === null
      ? controlError("held_output_unavailable", 503)
      : controlJson(view);
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const body = await readJsonRecord(request);
  const decision = body.ok ? parseAgentPermissionDecision(body.value) : null;
  if (decision === null)
    return controlError("held_output_decision_invalid", 422);
  return decide(
    { request, organisationIdRaw: route.organisationIdRaw },
    {
      kind: "held_output",
      id: route.requestId,
      answer: decision === "allow" ? "allow" : "refuse",
    },
  );
}

/**
 * Records the answer to one held output and releases it. The person who
 * asked for the output, or an owner or admin, may answer.
 */
export async function decideHeldOutput(
  env: Env,
  proof: PendingDecisionProof,
  call: Readonly<{ id: string; answer: PendingDecisionAnswer }>,
): Promise<Response> {
  const decision = call.answer === "allow" ? "allow" : "deny";
  const authorized = await authorizeOrganisationRequest(
    proof.request,
    env,
    proof.organisationIdRaw,
    "viewer",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const stored = await readDecidable(env, authorized, call.id);
  if (stored === null) return controlError("held_output_not_found", 404);
  const now = Date.now();
  let decided = stored;
  if (stored.status === "pending") {
    if (stored.createdAt + HELD_OUTPUT_REQUEST_LIFETIME_MS < now)
      return controlError("held_output_expired", 409);
    const recorded = await decideHeldOutputRequest(authorized.executionScope, {
      requestId: stored.requestId,
      status: decision === "allow" ? "allowed" : "denied",
      userId: authorized.authenticated.session.userId,
      now,
    });
    if (!recorded.ok) return controlError("held_output_unavailable", 503);
    decided = recorded.value;
  }
  if (decided.status !== (decision === "allow" ? "allowed" : "denied"))
    return controlError("held_output_decided", 409);
  // The decision is stored. When the delivery cannot finish now, the scheduled
  // reconciliation tries again; a repeated decision tries at once.
  const released = await slackSurfaceParts
    .use()
    .releaseHeldOutputDecision(env, authorized.executionScope, decided);
  return controlJson({ ok: true, status: decided.status, released });
}

/** The held answers that wait for this member, for the pending list. */
export async function heldOutputSummaries(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<readonly HeldOutputSummary[]> {
  const now = Date.now();
  const pending = await listPendingHeldOutputRequests(
    authorized.executionScope.database,
    authorized.organisationId,
    now,
  );
  if (pending.length === 0) return [];
  const viewer = await memberViewer(env, authorized);
  if (viewer === null) return [];
  const summaries: HeldOutputSummary[] = [];
  for (const stored of pending) {
    if (!(await mayDecide(viewer, authorized, stored))) continue;
    summaries.push({
      requestId: stored.requestId,
      reason: stored.reason,
      destination: await destinationName(authorized, stored),
      effect: effectLabel(stored),
      conversationId: await chatConversationId(authorized, stored),
      createdAt: stored.createdAt,
      expiresAt: stored.createdAt + HELD_OUTPUT_REQUEST_LIFETIME_MS,
    });
  }
  return summaries;
}

async function readDecidable(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  requestId: string,
): Promise<HeldOutputRequest | null> {
  const stored = await readHeldOutputRequest(
    authorized.executionScope.database,
    authorized.organisationId,
    requestId,
  );
  if (stored === null) return null;
  const viewer = await memberViewer(env, authorized);
  return viewer !== null && (await mayDecide(viewer, authorized, stored))
    ? stored
    : null;
}

async function memberViewer(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<MemberViewer | null> {
  const scope = authenticatedConversationScope(
    authorized.organisationId,
    authorized.authenticated.session,
  );
  const authority = await readChatControlAuthority(
    authorized.executionScope.database,
    scope,
  );
  return authority === null
    ? null
    : {
        env,
        organisationId: authorized.organisationId,
        execution: authorized.executionScope,
        scope,
        authority,
      };
}

async function restoredLabel(
  stored: HeldOutputRequest,
): Promise<FlowLabel | null> {
  const label = await FlowLabel.restore(JSON.parse(stored.flowLabelJson));
  return label.ok ? label.value : null;
}

async function mayDecide(
  viewer: MemberViewer,
  authorized: AuthorizedOrganisationRequest,
  stored: HeldOutputRequest,
): Promise<boolean> {
  const label = await restoredLabel(stored);
  if (label === null || !(await memberMaySee(viewer, label))) return false;
  if (stored.reason === "private_source") return true;
  // Only the person who asked knows if they wanted this action (Plan 89).
  if (stored.reason === "outside_written")
    return stored.requesterPersonId === viewer.authority.requesterPersonId;
  return (
    authorized.membership.role === "owner" ||
    authorized.membership.role === "admin" ||
    stored.requesterPersonId === viewer.authority.requesterPersonId
  );
}

async function heldOutputView(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  stored: HeldOutputRequest,
): Promise<HeldOutputView | null> {
  const label = await restoredLabel(stored);
  if (label === null) return null;
  const base = {
    requestId: stored.requestId,
    reason: stored.reason,
    status: stored.status,
    destination: await destinationName(authorized, stored),
    effect: effectLabel(stored),
    conversationId: await chatConversationId(authorized, stored),
    source: sourceName(label),
    createdAt: stored.createdAt,
    expiresAt: stored.createdAt + HELD_OUTPUT_REQUEST_LIFETIME_MS,
  };
  if (stored.subject === "effect")
    return {
      ...base,
      covers:
        stored.effect !== null &&
        heldEffectCoversRequest(stored.effect.resourceScope)
          ? "request"
          : "step",
      answer: null,
      action: stored.effect?.action?.view ?? null,
    };
  const caseId = parseCaseId(stored.caseId ?? "");
  if (!caseId.ok) return null;
  const caseActor = await resolveActiveCaseActorAtPlacement({
    env,
    namespace: env.CASE,
    organisationId: authorized.organisationId,
    caseId: caseId.value,
    placement: authorized.executionScope.placement,
    now: Date.now(),
  });
  if (!caseActor.ok) return null;
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) return null;
  const lifecycle = snapshot.value.outputs.find(
    (candidate) => candidate.output.outputId === stored.outputId,
  );
  const content = lifecycle?.output.delivery.content;
  if (content?.kind !== "text") return null;
  return { ...base, covers: "step", answer: content.text, action: null };
}

/** The catalogue name of a held tool effect. Null for an answer. */
function effectLabel(stored: HeldOutputRequest): string | null {
  if (stored.effect === null) return null;
  const capabilityId = parseActiveCapabilityId(stored.effect.capabilityId);
  return capabilityId === null
    ? stored.effect.capabilityId
    : capabilityDefinitionById(capabilityId).label;
}

/**
 * The Portal chat of a step that a person's chat turn asked about, so that
 * the chat opens its prompt. Null for a Slack thread.
 */
async function chatConversationId(
  authorized: AuthorizedOrganisationRequest,
  stored: HeldOutputRequest,
): Promise<string | null> {
  if (stored.effect === null || stored.requestAuthority.kind !== "control")
    return null;
  return readSessionConversationId(
    authorized.executionScope.database,
    authorized.organisationId,
    stored.effect.sessionId,
  );
}

/** The channel's name from the newest discovery, when Pantry knows it. */
async function destinationName(
  authorized: AuthorizedOrganisationRequest,
  stored: HeldOutputRequest,
): Promise<string | null> {
  if (stored.channelId === null) return null;
  return readDiscoveredResourceLabel(
    authorized.executionScope.database,
    authorized.organisationId,
    stored.channelId,
  );
}

/** Where the private content came from, in words that a person can judge. */
function sourceName(label: FlowLabel): HeldOutputView["source"] {
  const kinds = new Set(
    label.policies
      .filter((policy) => policyLevel(policy) === "private")
      .flatMap((policy) => policy.readers.map((reader) => reader.kind)),
  );
  if (kinds.has("person")) return "direct_message";
  if (kinds.has("chat_conversation")) return "portal_chat";
  if (kinds.has("conversation")) return "private_slack";
  return "internal";
}
