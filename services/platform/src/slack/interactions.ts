import { isSideCaseProposalId } from "@purin-labs/control-api";
import { errorMessage, isRecord, parseJsonOrNull } from "@purin-labs/std";

import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import type { SlackSideCaseStartRefusal } from "../actors/connector-side-case";
import type { Env } from "../env";
import { errorResponse, methodNotAllowed } from "../http";
import {
  newRequestId,
  parseChannelId,
  parseConnectorId,
  parseSlackAppId,
  parseWorkspaceId,
  type ChannelId,
  type RequestId,
  type SlackAppId,
  type WorkspaceId,
} from "../ids";
import { traceLog, traceWarn } from "../observability";
import { parseSlackUserId, type SlackUserId } from "./events";
import { resolveConfiguredSlackInstallationIdentity } from "./installation-identity";
import { resolveOrClaimSlackThreadRoute } from "./organisation-routing";
import { SLACK_SIDE_CASE_START_ACTION } from "./side-cases";
import {
  SLACK_COMMERCE_APPROVE_ACTION,
  SLACK_COMMERCE_DECLINE_ACTION,
} from "./commerce-approval-card";
import { decideCommerceActionFromSlack } from "./commerce-approval";
import {
  decideBakeProposalFromSlack,
  type BakeDecisionClick,
} from "./bake-proposal-decision";
import {
  SLACK_BAKE_APPROVE_ACTION,
  SLACK_BAKE_REASON_ACTION,
  SLACK_BAKE_REASON_BLOCK,
  SLACK_BAKE_REJECT_ACTION,
} from "./bake-proposal-card";
import { SLACK_PERMISSION_DENY_ACTION } from "./permission-request-notice";
import { denyPermissionRequestFromSlack } from "./permission-request-deny";
import { tellClicker } from "./interaction-reply";
import { verifySlackSignature } from "./signature";

/**
 * Slack interactions: clicks on the buttons of Pantry's messages: the Start
 * button of a side Case proposal (Plan 74) and the Approve and Decline buttons
 * of a commerce change that waits for approval (Plan 56).
 *
 * Slack waits three seconds for the answer. The handler verifies the
 * signature, reads the click, and answers at once. The start then runs in
 * the Connector of the proposal's thread. Each step of a start keeps its
 * result, so a click whose start stopped part of the way is finished by the
 * next click. A refusal goes to the person who clicked, and to nobody else,
 * through the interaction's response URL.
 */
export async function handleSlackInteractions(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const requestId = newRequestId();
  const receivedAt = Date.now();
  const rawBody = await request.text();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim() ?? "";
  if (signingSecret.length === 0) {
    traceWarn("integration_gateway.slack.missing_signing_secret", {
      requestId,
    });
    return errorResponse(
      "missing_slack_signing_secret",
      "Slack signing secret is not configured.",
      500,
    );
  }
  const verified = await verifySlackSignature(
    request.headers,
    rawBody,
    signingSecret,
    receivedAt,
  );
  if (!verified.ok) {
    traceWarn("integration_gateway.slack.interaction_signature_rejected", {
      requestId,
      reason: verified.reason,
    });
    return errorResponse(
      "invalid_slack_signature",
      "Slack signature verification failed.",
      401,
    );
  }
  const click = parseSideCaseStartClick(rawBody);
  if (click !== null)
    ctx.waitUntil(startSideCaseFromClick(env, click, requestId, receivedAt));
  const decision = parseCommerceDecisionClick(rawBody);
  if (decision !== null)
    ctx.waitUntil(decideFromClick(env, decision, requestId));
  const denial = parsePermissionDenyClick(rawBody);
  if (denial !== null) ctx.waitUntil(denyFromClick(env, denial, requestId));
  const bake = parseBakeDecisionClick(rawBody);
  if (bake !== null)
    ctx.waitUntil(decideBakeProposalFromSlack(env, bake, requestId));
  return new Response(null, { status: 200 });
}

/** A click on the Start button of a side Case proposal. */
type SideCaseStartClick = Readonly<{
  appId: SlackAppId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  /** The root of the thread that holds the proposal. */
  threadTs: string;
  starter: SlackUserId;
  proposalId: string;
  responseUrl: string;
}>;

const SLACK_MESSAGE_TS = /^\d+\.\d+$/u;
const SLACK_RESPONSE_URL_PREFIX = "https://hooks.slack.com/";

/** The fields of a button click that every Pantry button needs. */
type ClickEnvelope = Omit<SideCaseStartClick, "proposalId"> &
  Readonly<{ actions: readonly unknown[] }>;

/**
 * The click, read from Slack's form body. Null for every other interaction
 * and for a click that is not in a thread.
 */
function parseClickEnvelope(rawBody: string): ClickEnvelope | null {
  const payload = parseJsonOrNull(
    new URLSearchParams(rawBody).get("payload") ?? "",
  );
  if (
    !isRecord(payload) ||
    payload.type !== "block_actions" ||
    !Array.isArray(payload.actions) ||
    !isRecord(payload.team) ||
    !isRecord(payload.user) ||
    !isRecord(payload.channel) ||
    typeof payload.api_app_id !== "string" ||
    typeof payload.team.id !== "string" ||
    typeof payload.user.id !== "string" ||
    typeof payload.channel.id !== "string" ||
    typeof payload.response_url !== "string" ||
    !payload.response_url.startsWith(SLACK_RESPONSE_URL_PREFIX)
  )
    return null;
  // The message names its thread; the container names it too. A card that
  // opens its own thread, such as a bake proposal's, is the thread's root.
  const threadTs =
    [payload.message, payload.container].map(threadOf).find(isSlackMessageTs) ??
    [payload.message, payload.container].map(rootOf).find(isSlackMessageTs);
  if (threadTs === undefined) return null;
  const appId = parseSlackAppId(payload.api_app_id);
  const workspaceId = parseWorkspaceId(payload.team.id);
  const channelId = parseChannelId(payload.channel.id);
  const starter = parseSlackUserId(payload.user.id, "user.id");
  if (!appId.ok || !workspaceId.ok || !channelId.ok || !starter.ok) return null;
  return {
    appId: appId.value,
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    threadTs,
    starter: starter.value,
    responseUrl: payload.response_url,
    actions: payload.actions,
  };
}

/** A click on Start: a side Case proposal in a thread. */
function parseSideCaseStartClick(rawBody: string): SideCaseStartClick | null {
  const envelope = parseClickEnvelope(rawBody);
  const action = envelope?.actions.find(isSideCaseStartAction);
  if (envelope === null || action === undefined) return null;
  const { actions: _actions, ...fields } = envelope;
  return { ...fields, proposalId: action.value };
}

/** A click on Approve or Decline: the click's fields, with the action nonce. */
type CommerceDecisionClick = Omit<SideCaseStartClick, "proposalId"> &
  Readonly<{ decision: "approve" | "decline"; actionNonce: string }>;

const ACTION_NONCE = /^[A-Za-z0-9_-]{1,128}$/u;

function parseCommerceDecisionClick(
  rawBody: string,
): CommerceDecisionClick | null {
  const envelope = parseClickEnvelope(rawBody);
  const action = envelope?.actions.find(isCommerceDecisionAction);
  if (envelope === null || action === undefined) return null;
  const { actions: _actions, ...fields } = envelope;
  return {
    ...fields,
    decision:
      action.action_id === SLACK_COMMERCE_DECLINE_ACTION
        ? "decline"
        : "approve",
    actionNonce: action.value,
  };
}

function isCommerceDecisionAction(
  action: unknown,
): action is Readonly<{ action_id: string; value: string }> {
  return (
    isRecord(action) &&
    action.type === "button" &&
    (action.action_id === SLACK_COMMERCE_APPROVE_ACTION ||
      action.action_id === SLACK_COMMERCE_DECLINE_ACTION) &&
    typeof action.value === "string" &&
    ACTION_NONCE.test(action.value)
  );
}

/**
 * Decide the change through the Organisation of the card's thread. The
 * thread's pin names the Organisation and its Slack account.
 */
async function decideFromClick(
  env: Env,
  click: CommerceDecisionClick,
  requestId: RequestId,
): Promise<void> {
  const installation = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installation.ok || installation.value.appId !== click.appId) return;
  const route = await resolveOrClaimSlackThreadRoute(env.DB, {
    kind: "reply",
    environment: installation.value.environment,
    appId: installation.value.appId,
    workspaceId: click.workspaceId,
    channelId: click.channelId,
    rootMessageTs: click.threadTs,
  });
  if (route.kind !== "resolved" || route.value.placement === null) return;
  await decideCommerceActionFromSlack(env, {
    decision: click.decision,
    organisationId: route.value.organisationId,
    integrationAccountId: route.value.integrationAccountId,
    workspaceId: click.workspaceId,
    channelId: click.channelId,
    approverSlackUserId: click.starter,
    actionNonce: click.actionNonce,
    responseUrl: click.responseUrl,
    requestId,
  });
}

/**
 * A click on Approve or Reject of a bake proposal's card (Plan 24 S1), with
 * the text of the card's reason field.
 */
function parseBakeDecisionClick(rawBody: string): BakeDecisionClick | null {
  const envelope = parseClickEnvelope(rawBody);
  const action = envelope?.actions.find(isBakeDecisionAction);
  if (envelope === null || action === undefined) return null;
  const { actions: _actions, ...fields } = envelope;
  return {
    ...fields,
    decision:
      action.action_id === SLACK_BAKE_REJECT_ACTION ? "reject" : "approve",
    proposalId: action.value,
    reason: bakeReasonOf(rawBody),
  };
}

function isBakeDecisionAction(
  action: unknown,
): action is Readonly<{ action_id: string; value: string }> {
  return (
    isRecord(action) &&
    action.type === "button" &&
    (action.action_id === SLACK_BAKE_APPROVE_ACTION ||
      action.action_id === SLACK_BAKE_REJECT_ACTION) &&
    typeof action.value === "string" &&
    BAKE_PROPOSAL_ID.test(action.value)
  );
}

const BAKE_PROPOSAL_ID = /^bake_[a-f0-9]{24}$/u;

/** The text of the card's reason field when the person clicked. */
function bakeReasonOf(rawBody: string): string | null {
  const payload = parseJsonOrNull(
    new URLSearchParams(rawBody).get("payload") ?? "",
  );
  const values =
    isRecord(payload) && isRecord(payload.state) ? payload.state.values : null;
  const block = isRecord(values) ? values[SLACK_BAKE_REASON_BLOCK] : null;
  const field = isRecord(block) ? block[SLACK_BAKE_REASON_ACTION] : null;
  return isRecord(field) && typeof field.value === "string"
    ? field.value
    : null;
}

/** A click on Deny: the click's fields, with the permission request's id. */
type PermissionDenyClick = Omit<SideCaseStartClick, "proposalId"> &
  Readonly<{ permissionRequestId: string }>;

const PERMISSION_REQUEST_ID = /^[0-9a-f]{32}$/u;

function parsePermissionDenyClick(rawBody: string): PermissionDenyClick | null {
  const envelope = parseClickEnvelope(rawBody);
  const action = envelope?.actions.find(isPermissionDenyAction);
  if (envelope === null || action === undefined) return null;
  const { actions: _actions, ...fields } = envelope;
  return { ...fields, permissionRequestId: action.value };
}

function isPermissionDenyAction(
  action: unknown,
): action is Readonly<{ value: string }> {
  return (
    isRecord(action) &&
    action.type === "button" &&
    action.action_id === SLACK_PERMISSION_DENY_ACTION &&
    typeof action.value === "string" &&
    PERMISSION_REQUEST_ID.test(action.value)
  );
}

/** Deny through the Organisation of the card's thread. */
async function denyFromClick(
  env: Env,
  click: PermissionDenyClick,
  requestId: RequestId,
): Promise<void> {
  const installation = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installation.ok || installation.value.appId !== click.appId) return;
  const route = await resolveOrClaimSlackThreadRoute(env.DB, {
    kind: "reply",
    environment: installation.value.environment,
    appId: installation.value.appId,
    workspaceId: click.workspaceId,
    channelId: click.channelId,
    rootMessageTs: click.threadTs,
  });
  if (route.kind !== "resolved" || route.value.placement === null) return;
  await denyPermissionRequestFromSlack(env, {
    organisationId: route.value.organisationId,
    integrationAccountId: route.value.integrationAccountId,
    workspaceId: click.workspaceId,
    slackUserId: click.starter,
    permissionRequestId: click.permissionRequestId,
    responseUrl: click.responseUrl,
    requestId,
  });
}

function threadOf(value: unknown): unknown {
  return isRecord(value) ? value.thread_ts : undefined;
}

function rootOf(value: unknown): unknown {
  return isRecord(value) ? (value.message_ts ?? value.ts) : undefined;
}

function isSlackMessageTs(value: unknown): value is string {
  return typeof value === "string" && SLACK_MESSAGE_TS.test(value);
}

function isSideCaseStartAction(
  action: unknown,
): action is Readonly<{ value: string }> {
  return (
    isRecord(action) &&
    action.type === "button" &&
    action.action_id === SLACK_SIDE_CASE_START_ACTION &&
    isSideCaseProposalId(action.value)
  );
}

/**
 * Ask the Connector of the proposal's thread to start the side Case. The
 * thread's pin names the Organisation and its Connector. Every outcome other
 * than a start is told to the person who clicked.
 */
async function startSideCaseFromClick(
  env: Env,
  click: SideCaseStartClick,
  requestId: RequestId,
  receivedAt: number,
): Promise<void> {
  try {
    const installation = resolveConfiguredSlackInstallationIdentity({
      deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
      appId: env.SLACK_APP_ID,
    });
    if (!installation.ok || installation.value.appId !== click.appId) return;
    const route = await resolveOrClaimSlackThreadRoute(env.DB, {
      kind: "reply",
      environment: installation.value.environment,
      appId: installation.value.appId,
      workspaceId: click.workspaceId,
      channelId: click.channelId,
      rootMessageTs: click.threadTs,
    });
    if (route.kind !== "resolved" || route.value.placement === null) {
      await tellStarter(click, requestId, REFUSALS.side_case_unavailable);
      return;
    }
    const connectorId = parseConnectorId(
      `connector_slack_${route.value.integrationAccountId}`,
    );
    if (!connectorId.ok) return;
    const connector = await resolveActiveConnectorActorAtPlacement({
      env,
      namespace: env.CONNECTOR,
      organisationId: route.value.organisationId,
      connectorId: connectorId.value,
      placement: route.value.placement,
      now: receivedAt,
    });
    if (!connector.ok) {
      await tellStarter(click, requestId, START_FAILED);
      return;
    }
    const outcome = await connector.value.startSlackSideCase({
      identity: {
        organisationId: route.value.organisationId,
        connectorId: connectorId.value,
      },
      proposalId: click.proposalId,
      workspaceId: click.workspaceId,
      channelId: click.channelId,
      threadTs: click.threadTs,
      starterSlackUserId: click.starter,
    });
    const result = outcome.ok ? outcome.value : null;
    traceLog("integration_gateway.slack.side_case_start", {
      requestId,
      organisation_id: route.value.organisationId,
      channel_id: click.channelId,
      proposal_id: click.proposalId,
      outcome: result?.kind ?? "connector_refused",
      detail:
        result === null
          ? outcome.ok
            ? null
            : outcome.error.code
          : result.kind === "refused"
            ? result.code
            : result.kind === "failed"
              ? result.reason
              : null,
      elapsed_ms: Date.now() - receivedAt,
    });
    if (result?.kind === "started") return;
    await tellStarter(
      click,
      requestId,
      result?.kind === "refused" ? REFUSALS[result.code] : START_FAILED,
    );
  } catch (error) {
    traceWarn("integration_gateway.slack.side_case_start_failed", {
      requestId,
      channel_id: click.channelId,
      proposal_id: click.proposalId,
      detail: errorMessage(error),
    });
    await tellStarter(click, requestId, START_FAILED);
  }
}

const REFUSALS: Readonly<Record<SlackSideCaseStartRefusal, string>> = {
  side_case_unavailable: "The server cannot find this proposal.",
  side_case_starter_not_permitted:
    "You cannot start this side Case. Only a member whose Slack account is linked to Seams Pantry, and who may give Sous Chef work here, can start it.",
  side_case_not_permitted:
    "This side Case cannot start here. It holds information that this conversation may not receive.",
  side_case_expired:
    "This proposal expired. Ask Sous Chef again if the work is still necessary.",
  side_case_started_by_another:
    "Another person already started this side Case.",
};

const START_FAILED =
  "The server could not start this side Case. Click Start again to continue.";

/** A message that only the person who clicked sees. */
async function tellStarter(
  click: SideCaseStartClick,
  requestId: RequestId,
  text: string,
): Promise<void> {
  if (!(await tellClicker(click.responseUrl, text)))
    traceWarn("integration_gateway.slack.side_case_notice_failed", {
      requestId,
      channel_id: click.channelId,
      proposal_id: click.proposalId,
    });
}
