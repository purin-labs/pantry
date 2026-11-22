/**
 * Slack message drafts in a Portal chat. The agent prepares a draft with the
 * `slack_message_propose` tool; a person reads it in the conversation and
 * sends, edits or discards it here. Each route reads the draft through the
 * conversation that holds its Case, so a person who cannot open the chat
 * cannot see or act on its drafts.
 */
import { SLACK_APP_NAME, SLACK_BOT_NAME } from "@purin-labs/control-api";
import type { GlobalDatabase } from "../../database-handles";
import { signalChat } from "../../chat/signals";
import { isConversationId } from "@purin-labs/control-api";
import { assertNever, hasExactKeys } from "@purin-labs/std";
import {
  resolveActiveConnectorActorAtPlacement,
  type ActorResolutionError,
} from "../../actors/actor-router";
import type { Result } from "../../result";
import { deriveDirectCaseIdentities } from "../../actors/case-direct-processing";
import { conversationCaseIdentity } from "../../chat/conversation-access";
import type { ConversationScope } from "../../chat/store";
import {
  claimSlackMessageSend,
  editSlackMessageProposal,
  isSlackChannelId,
  listSlackMessageProposalsForCase,
  readSlackChannelOptions,
  readSlackMessageProposal,
  rejectSlackMessageProposal,
  settleSlackMessageSend,
  SLACK_MESSAGE_MAX_LENGTH,
  withExpiry,
  type SlackChannelOptions,
  type SlackMessageProposal,
} from "../../data/slack-message-proposal";
import type { Env } from "../../env";
import type { ConnectorActorStub } from "../../actors/actor-stubs";
import { parseConnectorId } from "../../ids";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";

export type SlackMessageAction = "send" | "discard" | "edit";

/**
 * The drafts of the chat's Case for the conversation read. Each draft names
 * its channel, so the card shows "#general" without another request.
 */
export async function readConversationSlackDrafts(
  globalDatabase: GlobalDatabase,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversationId: string,
): Promise<readonly Record<string, unknown>[] | null> {
  if (!isConversationId(conversationId)) return null;
  const caseId = await conversationCase(placement, scope, conversationId);
  if (caseId === null) return null;
  const now = Date.now();
  const proposals = await listSlackMessageProposalsForCase({
    db: placement.database,
    organisationId: scope.organisationId,
    caseId,
    now,
  });
  const options = new Map<string, SlackChannelOptions | null>();
  const drafts: Record<string, unknown>[] = [];
  for (const proposal of proposals) {
    let channels = options.get(proposal.integrationAccountId);
    if (channels === undefined) {
      channels = await readSlackChannelOptions({
        globalDatabase,
        db: placement.database,
        organisationId: scope.organisationId,
        integrationAccountId: proposal.integrationAccountId,
      });
      options.set(proposal.integrationAccountId, channels);
    }
    drafts.push(slackDraftWire(proposal, channels));
  }
  return drafts;
}

/**
 * GET returns the draft with the channels it may go to. POST `send` posts the
 * exact version and text that the person saw; `edit` replaces the text or the
 * channel; `discard` closes the draft without posting.
 */
export async function handlePortalChatSlackMessage(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  conversationIdRaw: string,
  proposalIdRaw: string,
  action: SlackMessageAction | null,
): Promise<Response> {
  if (request.method !== (action === null ? "GET" : "POST"))
    return controlError("method_not_allowed", 405);
  if (!isConversationId(conversationIdRaw) || proposalIdRaw.length > 200)
    return controlError("slack_message_request_invalid", 422);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    action !== null,
  );
  if (!authorized.ok) return authorized.response;
  const placement = authorized.executionScope;
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const caseId = await conversationCase(placement, scope, conversationIdRaw);
  if (caseId === null) return controlError("chat_not_found", 404);
  const stored = await readSlackMessageProposal({
    db: placement.database,
    organisationId: scope.organisationId,
    proposalId: proposalIdRaw,
  });
  // A draft of another Case answers as a missing one.
  if (stored === null || stored.caseId !== caseId)
    return controlError("slack_message_not_found", 404);
  const now = Date.now();
  const proposal = withExpiry(stored, now);
  const options = await readSlackChannelOptions({
    globalDatabase: env.DB,
    db: placement.database,
    organisationId: scope.organisationId,
    integrationAccountId: proposal.integrationAccountId,
  });
  if (action === null)
    return controlJson({
      ok: true,
      draft: slackDraftWire(proposal, options),
      channels:
        options?.channels.map((channel) => ({
          channelId: channel.channelId,
          name: channel.name,
        })) ?? [],
    });
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("slack_message_request_invalid", 422);
  const response = await applySlackMessageAction(
    env,
    action,
    placement,
    scope,
    proposal,
    body.value,
    options,
    now,
  );
  // The draft card shows on every page that has this conversation open.
  if (response.ok)
    signalChat(placement, {
      kind: "conversation",
      conversationId: conversationIdRaw,
    });
  return response;
}

function applySlackMessageAction(
  env: Env,
  action: SlackMessageAction,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  proposal: Parameters<typeof discardDraft>[2],
  body: Record<string, unknown>,
  options: Parameters<typeof discardDraft>[4],
  now: number,
): Promise<Response> {
  switch (action) {
    case "discard":
      return discardDraft(placement, scope, proposal, body, options, now);
    case "edit":
      return editDraft(placement, proposal, body, options, now);
    case "send":
      return sendDraft(env, placement, scope, proposal, body, options);
    default:
      return assertNever(action);
  }
}

async function discardDraft(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  proposal: SlackMessageProposal,
  body: Record<string, unknown>,
  options: SlackChannelOptions | null,
  now: number,
): Promise<Response> {
  if (!hasExactKeys(body, ["version"]) || !isVersion(body.version))
    return controlError("slack_message_request_invalid", 422);
  if (
    proposal.lifecycleKind === "rejected" &&
    proposal.version === body.version
  )
    return controlJson({ ok: true, draft: slackDraftWire(proposal, options) });
  const rejected = await rejectSlackMessageProposal({
    scope: placement,
    proposalId: proposal.proposalId,
    version: body.version,
    decidedByUserId: scope.userId,
    now,
  });
  if (!rejected.ok) return draftConflict(rejected.error.code);
  return controlJson({
    ok: true,
    draft: slackDraftWire(rejected.value, options),
  });
}

async function editDraft(
  placement: OrganisationExecutionScope,
  proposal: SlackMessageProposal,
  body: Record<string, unknown>,
  options: SlackChannelOptions | null,
  now: number,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["version", "text", "channelId"]) ||
    !isVersion(body.version) ||
    typeof body.text !== "string" ||
    body.text.trim().length === 0 ||
    body.text.length > SLACK_MESSAGE_MAX_LENGTH ||
    (body.channelId !== null && typeof body.channelId !== "string")
  )
    return controlError("slack_message_request_invalid", 422);
  if (body.channelId !== null && !connectedChannel(options, body.channelId))
    return controlError("slack_message_channel_unavailable", 409);
  const edited = await editSlackMessageProposal({
    scope: placement,
    proposalId: proposal.proposalId,
    expectedVersion: body.version,
    body: body.text.trim(),
    channelId: body.channelId,
    now,
  });
  if (!edited.ok) return draftConflict(edited.error.code);
  return controlJson({
    ok: true,
    draft: slackDraftWire(edited.value, options),
  });
}

async function sendDraft(
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  proposal: SlackMessageProposal,
  body: Record<string, unknown>,
  options: SlackChannelOptions | null,
): Promise<Response> {
  if (
    !hasExactKeys(body, ["version", "bodyDigest", "channelId"]) ||
    !isVersion(body.version) ||
    typeof body.bodyDigest !== "string" ||
    typeof body.channelId !== "string"
  )
    return controlError("slack_message_request_invalid", 422);
  // Sending what was already sent answers with the sent draft.
  if (
    proposal.lifecycleKind === "sent" &&
    proposal.version === body.version &&
    proposal.bodyDigest === body.bodyDigest
  )
    return controlJson({ ok: true, draft: slackDraftWire(proposal, options) });
  if (options === null || !connectedChannel(options, body.channelId))
    return controlError("slack_message_channel_unavailable", 409);
  const claimed = await claimSlackMessageSend({
    scope: placement,
    proposalId: proposal.proposalId,
    version: body.version,
    bodyDigest: body.bodyDigest,
    channelId: body.channelId,
    decidedByUserId: scope.userId,
    now: Date.now(),
  });
  if (!claimed.ok) return draftConflict(claimed.error.code);
  const delivered = await deliverDraft(env, placement, claimed.value, {
    workspaceId: options.workspaceId,
    channelId: body.channelId,
  });
  const settled = await settleSlackMessageSend({
    scope: placement,
    proposalId: proposal.proposalId,
    version: claimed.value.version,
    outcome: delivered,
    now: Date.now(),
  });
  if (!settled.ok) return draftConflict(settled.error.code);
  // A failed post is a state of the draft: it says why and can be sent again.
  return controlJson({
    ok: true,
    draft: slackDraftWire(settled.value, options),
  });
}

/**
 * Posts through the workspace's Connector. The delivery key is the draft and
 * its version, so a repeated Send of the same version posts at most once.
 * Slack refusing the post, as for a channel the bot is not in, closes that
 * key; the draft's next Send then uses a new version.
 */
async function deliverDraft(
  env: Env,
  placement: OrganisationExecutionScope,
  proposal: SlackMessageProposal,
  destination: Readonly<{ workspaceId: string; channelId: string }>,
): Promise<
  | Readonly<{ kind: "sent"; channelId: string; messageTs: string }>
  | Readonly<{ kind: "failed"; code: string; final: boolean }>
> {
  const connectorId = parseConnectorId(
    `connector_slack_${proposal.integrationAccountId}`,
  );
  if (!connectorId.ok)
    return { kind: "failed", code: "connector_invalid", final: false };
  const requestedAt = Date.now();
  let connector: Result<ConnectorActorStub, ActorResolutionError>;
  try {
    connector = await resolveActiveConnectorActorAtPlacement({
      env,
      namespace: env.CONNECTOR,
      organisationId: placement.organisationId,
      connectorId: connectorId.value,
      placement: placement.placement,
      now: requestedAt,
    });
  } catch {
    return { kind: "failed", code: "connector_unavailable", final: false };
  }
  if (!connector.ok)
    return { kind: "failed", code: "connector_unavailable", final: false };
  const identity = `${proposal.proposalId}:${String(proposal.version)}:${destination.channelId}`;
  let result: Awaited<ReturnType<typeof connector.value.deliver>>;
  try {
    result = await connector.value.deliver({
      identity: {
        organisationId: placement.organisationId,
        connectorId: connectorId.value,
      },
      delivery: {
        deliveryId: `chat_slack_message_${identity}`,
        bindingId: `chat_slack_message_binding_${proposal.proposalId}`,
        address: {
          kind: "slack_channel",
          workspaceId: destination.workspaceId,
          channelId: destination.channelId,
        },
        caseId: proposal.caseId,
        caseRevision: proposal.version,
        content: { kind: "text", text: proposal.body },
        idempotencyKey: `chat_slack_message:${identity}`,
        addressedAt: requestedAt,
      },
      requestedAt,
    });
  } catch {
    return { kind: "failed", code: "connector_unavailable", final: false };
  }
  if (!result.ok)
    return { kind: "failed", code: result.error.code, final: false };
  switch (result.value.kind) {
    case "delivered":
    case "already_delivered":
      return {
        kind: "sent",
        channelId: destination.channelId,
        messageTs: result.value.receipt.nativeReceiptId,
      };
    case "retry":
      return {
        kind: "failed",
        code: `retry:${result.value.reason}`,
        final: false,
      };
    case "rejected":
      return { kind: "failed", code: result.value.reason, final: true };
    default:
      return assertNever(result.value);
  }
}

function sendFailureMessage(code: string): string {
  if (code === "not_in_channel")
    return `${SLACK_BOT_NAME} is not in that channel. Invite the ${SLACK_APP_NAME} app to the channel in Slack, then send again.`;
  if (code === "channel_not_found" || code === "is_archived")
    return "Slack could not find that channel. Choose another channel and send again.";
  if (code.startsWith("retry:"))
    return "Slack did not answer in time. The message was not posted. Send again in a moment.";
  return "Slack did not accept the message. The message was not posted.";
}

function slackDraftWire(
  proposal: SlackMessageProposal,
  options: SlackChannelOptions | null,
): Record<string, unknown> {
  const channelId = proposal.sentChannelId ?? proposal.channelId;
  const channel =
    channelId === null
      ? null
      : (options?.channels.find((option) => option.channelId === channelId) ??
        null);
  return {
    proposalId: proposal.proposalId,
    version: proposal.version,
    workspaceName: options?.workspaceName ?? null,
    channelId,
    channelName: channel?.name ?? null,
    channelHint: proposal.channelHint,
    body: proposal.body,
    bodyDigest: proposal.bodyDigest,
    lifecycle: proposal.lifecycleKind,
    failureCode: proposal.failureCode,
    failureMessage:
      proposal.failureCode === null
        ? null
        : sendFailureMessage(proposal.failureCode),
    messageTs: proposal.sentMessageTs,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    expiresAt: proposal.expiresAt,
  };
}

/** The chat's Case, when this person may open the chat; otherwise null. */
export async function conversationCase(
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  conversationId: string,
): Promise<string | null> {
  if (!isConversationId(conversationId)) return null;
  let identity: string;
  try {
    identity = await conversationCaseIdentity(
      placement.database,
      scope,
      conversationId,
    );
  } catch {
    return null;
  }
  const derived = await deriveDirectCaseIdentities(identity);
  return derived.ok ? derived.value.caseId : null;
}

function connectedChannel(
  options: SlackChannelOptions | null,
  channelId: string,
): boolean {
  return (
    isSlackChannelId(channelId) &&
    options !== null &&
    options.channels.some((channel) => channel.channelId === channelId)
  );
}

function draftConflict(
  code: "slack_message_conflict" | "slack_message_store_failed",
): Response {
  return code === "slack_message_conflict"
    ? controlError("slack_message_conflict", 409)
    : controlError("slack_message_unavailable", 503);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
