import { isSideCaseProposalId } from "@purin-labs/control-api";
import type { ConnectorIdentity } from "@purin-labs/contracts";
import { isNonBlankString, isRecord } from "@purin-labs/std";

import { resolveActiveSlackThreadCredential } from "../credential-vault";
import { parsePersonId } from "../data/person-authz";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseChannelId,
  parseOrganisationId,
  parseWorkspaceId,
} from "@purin-labs/kernel/ids";
import type { SlackCaseCommand } from "../slack/case-command-message";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { refreshSlackRequestAuthority } from "../request-authority";
import { resolveSlackLinkedMember } from "./action-mutation-execution";
import { deriveSlackCaseRouteIdentities } from "../slack/case-routing";
import {
  deriveSlackSessionId,
  deriveSlackThreadKey,
  parseSlackUserId,
  type SlackUserId,
} from "../slack/events";
import { resolveConfiguredSlackInstallationIdentity } from "../slack/installation-identity";
import {
  postSlackSideCaseMessage,
  readSlackPermalink,
  updateSlackSideCaseMessage,
} from "../slack/side-case-posts";
import {
  claimSlackSideCaseStart,
  readSlackSideCaseProposal,
  recordSlackSideCaseDestination,
  settleSlackSideCaseStart,
  slackSideCaseLinkMessage,
  slackSideCaseProposalMessage,
  slackSideCaseStartedMessage,
  slackSideCaseThreadMessage,
  type SlackSideCaseProposal,
} from "../slack/side-cases";
import { isActorExecutionActive } from "./actor-execution-quiescence";
import { decideStoredFlowConversationSink } from "./case-conversation-sink";
import { parseIdentityRecord } from "./connector-case-work";
import {
  acceptSlackSideCaseWork,
  readParkedSlackSideCase,
  recordSlackSideCasePost,
  slackSideCaseCommand,
  type ParkedSlackSideCase,
} from "./connector-slack-case-work";

/**
 * The Slack side of a side Case (Plan 74, Phase 2), in the Connector of the
 * thread where the agent proposed it. The Connector posts the proposal with
 * its Start button. When a person starts it, the Connector posts the root of
 * a new thread in the same channel, pins that thread to a new Case, queues
 * the brief as the Case's first work for that person, and links the new
 * thread in the proposing thread. Every step keeps its result, so a second
 * click finishes a start that stopped part of the way.
 */

type ConnectorSideCaseContext = Readonly<{
  env: Env;
  storage: DurableObjectStorage;
  scope: OrganisationExecutionScope;
  identity: ConnectorIdentity;
}>;

type SlackSideCaseProposalPost = Readonly<{
  identity: ConnectorIdentity;
  proposalId: string;
  title: string;
  brief: string;
}>;

export function parseSlackSideCaseProposalPost(
  value: unknown,
): SlackSideCaseProposalPost | null {
  if (
    !isRecord(value) ||
    !isSideCaseProposalId(value.proposalId) ||
    !isNonBlankString(value.title) ||
    !isNonBlankString(value.brief)
  )
    return null;
  const identity = parseIdentityRecord(value.identity);
  return identity === null
    ? null
    : {
        identity,
        proposalId: value.proposalId,
        title: value.title,
        brief: value.brief,
      };
}

/**
 * Post the proposal with its Start button in the thread of the proposing
 * turn, one time. The caller checked that the proposing turn's label may
 * reach the channel. False means that the thread does not hold it.
 */
export async function postSlackSideCaseProposal(
  context: ConnectorSideCaseContext,
  input: SlackSideCaseProposalPost,
): Promise<boolean> {
  const parked = readParkedSlackSideCase(context.storage.sql, input.proposalId);
  if (parked === null) throw new Error("connector_side_case_not_found");
  if (parked.proposalTs !== null) return true;
  const token = await threadToken(context, parked.command);
  if (token === null) return false;
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return false;
  const posted = await postSlackSideCaseMessage({
    token,
    channelId: parked.command.event.channelId,
    threadTs: parked.command.event.threadTs,
    message: slackSideCaseProposalMessage(input),
  });
  if (!posted.ok) return false;
  recordPost(context, input.proposalId, "proposal", posted.value);
  return true;
}

/** A click on Start, as the platform read it from a signed interaction. */
type SlackSideCaseStartRequest = Readonly<{
  identity: ConnectorIdentity;
  proposalId: string;
  workspaceId: string;
  channelId: string;
  /** The root of the thread that holds the clicked proposal. */
  threadTs: string;
  starterSlackUserId: SlackUserId;
}>;

export function parseSlackSideCaseStartRequest(
  value: unknown,
): SlackSideCaseStartRequest | null {
  if (
    !isRecord(value) ||
    !isSideCaseProposalId(value.proposalId) ||
    !isNonBlankString(value.workspaceId) ||
    !isNonBlankString(value.channelId) ||
    !isNonBlankString(value.threadTs) ||
    !isNonBlankString(value.starterSlackUserId)
  )
    return null;
  const identity = parseIdentityRecord(value.identity);
  const starter = parseSlackUserId(value.starterSlackUserId, "user");
  if (identity === null || !starter.ok) return null;
  return {
    identity,
    proposalId: value.proposalId,
    workspaceId: value.workspaceId,
    channelId: value.channelId,
    threadTs: value.threadTs,
    starterSlackUserId: starter.value,
  };
}

export type SlackSideCaseStartRefusal =
  /** No proposal of this thread has this id, or it is not in this channel. */
  | "side_case_unavailable"
  /** The clicker is not a member who may give Pantry work in this channel. */
  | "side_case_starter_not_permitted"
  /** The proposal's label may not reach this channel for this person now. */
  | "side_case_not_permitted"
  | "side_case_expired"
  | "side_case_started_by_another";

export type SlackSideCaseStartOutcome =
  | Readonly<{ kind: "started"; threadTs: string; caseId: string }>
  | Readonly<{ kind: "refused"; code: SlackSideCaseStartRefusal }>
  /** A step failed. Its earlier steps stay, and a second click goes on. */
  | Readonly<{ kind: "failed"; reason: string }>;

/**
 * Start a side Case for the person who clicked Start. The person must be a
 * member whose Slack identity is linked and who may give Pantry work, as for
 * a message. The proposal's binding must reach this channel with that
 * person's authority. The first work is queued for that person and runs
 * with their authority, which is read again when it runs.
 */
export async function startSlackSideCase(
  context: ConnectorSideCaseContext,
  input: SlackSideCaseStartRequest,
  now: number,
): Promise<SlackSideCaseStartOutcome> {
  const sql = context.storage.sql;
  const parked = readParkedSlackSideCase(sql, input.proposalId);
  const source = parked?.command;
  if (
    parked === null ||
    source === undefined ||
    source.event.workspaceId !== input.workspaceId ||
    source.event.channelId !== input.channelId ||
    source.event.threadTs !== input.threadTs
  )
    return refused("side_case_unavailable");
  const proposal = await readSlackSideCaseProposal(
    context.scope.database,
    String(context.scope.organisationId),
    input.proposalId,
  );
  if (
    proposal === null ||
    proposal.connectorId !== String(context.identity.connectorId) ||
    proposal.channelId !== source.event.channelId ||
    proposal.sourceThreadTs !== source.event.threadTs
  )
    return refused("side_case_unavailable");
  const starter = await resolveSideCaseStarter(
    context.scope,
    source,
    input.starterSlackUserId,
  );
  if (starter === null) return refused("side_case_starter_not_permitted");
  // The posts show the proposing turn's output in this channel. The label
  // must allow the channel for the starter now; the starter's authority is
  // not the proposing turn's, so no partition is compared.
  const sink = await decideStoredFlowConversationSink(
    starter.requestAuthority,
    proposal.flowBinding,
    source.event.channelId,
    context.env,
  );
  if (!sink.ok) return refused("side_case_not_permitted");
  const claim = await claimSlackSideCaseStart(
    context.scope,
    proposal,
    { userId: starter.userId, slackUserId: input.starterSlackUserId },
    now,
  );
  if (!claim.ok) return refused(claim.code);
  const token = await threadToken(context, source);
  if (token === null) return failed("connector_credential_unavailable");
  const thread = await ensureSideCaseThread(context, {
    parked,
    proposal: claim.proposal,
    token,
    starter: input.starterSlackUserId,
  });
  if (!thread.ok) return failed(thread.reason);
  const identities = sideCaseThreadIdentities(source, thread.threadTs);
  if (identities === null) return failed("side_case_identity_invalid");
  const recorded =
    claim.proposal.destinationCaseId === null
      ? await recordSlackSideCaseDestination(context.scope, claim.proposal, {
          threadTs: thread.threadTs,
          caseId: identities.target.caseId,
        })
      : claim.proposal;
  if (
    recorded.destinationThreadTs !== thread.threadTs ||
    recorded.destinationCaseId !== identities.target.caseId ||
    recorded.decidedAt === null
  )
    return failed("side_case_destination_conflict");
  const pinned = await pinSideCaseThread(context, source, {
    threadTs: thread.threadTs,
    caseId: identities.target.caseId,
    now,
  });
  if (!pinned) return failed("side_case_thread_pin_unavailable");
  // The brief is queued as the person's first message of the new thread. Its
  // time is the claim's, so a repeated start queues the same work.
  const command = slackSideCaseCommand(source, {
    proposalId: proposal.proposalId,
    brief: proposal.brief,
    receivedAt: recorded.decidedAt,
    threadTs: thread.threadTs,
    thread: identities.event,
    starter: {
      principalId: starter.principalId,
      userId: starter.userId,
      requestAuthority: starter.requestAuthority,
      author: input.starterSlackUserId,
    },
    target: { ...identities.target, placement: context.scope.placement },
  });
  if (!(await isActorExecutionActive(sql, context.scope)))
    return failed("connector_placement_conflict");
  const accepted = context.storage.transactionSync(
    acceptSlackSideCaseWork.bind(null, sql, context.identity, command),
  );
  if (!accepted.ok) return failed(accepted.error.code);
  const linked = await linkSideCaseThread(context, {
    parked: readParkedSlackSideCase(sql, input.proposalId) ?? parked,
    proposal: recorded,
    token,
    threadTs: thread.threadTs,
    starter: input.starterSlackUserId,
  });
  if (!linked.ok) return failed(linked.reason);
  if (recorded.status !== "started")
    await settleSlackSideCaseStart(context.scope, recorded, now);
  return {
    kind: "started",
    threadTs: thread.threadTs,
    caseId: identities.target.caseId,
  };
}

type StepResult<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

/** Post the root of the new thread, or find the one posted before. */
async function ensureSideCaseThread(
  context: ConnectorSideCaseContext,
  input: Readonly<{
    parked: ParkedSlackSideCase;
    proposal: SlackSideCaseProposal;
    token: string;
    starter: SlackUserId;
  }>,
): Promise<StepResult<{ readonly threadTs: string }>> {
  const kept = input.parked.threadTs ?? input.proposal.destinationThreadTs;
  if (kept !== null) {
    recordPost(context, input.proposal.proposalId, "thread", kept);
    return { ok: true, threadTs: kept };
  }
  const source = input.parked.command.event;
  const sourceUrl = await readSlackPermalink({
    token: input.token,
    channelId: source.channelId,
    messageTs: source.threadTs,
  });
  if (!sourceUrl.ok) return { ok: false, reason: sourceUrl.error.code };
  if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
    return { ok: false, reason: "connector_placement_conflict" };
  const posted = await postSlackSideCaseMessage({
    token: input.token,
    channelId: source.channelId,
    threadTs: null,
    message: slackSideCaseThreadMessage(
      input.proposal,
      input.starter,
      sourceUrl.value,
    ),
  });
  if (!posted.ok) return { ok: false, reason: posted.error.code };
  recordPost(context, input.proposal.proposalId, "thread", posted.value);
  return { ok: true, threadTs: posted.value };
}

/**
 * Post the link line in the proposing thread, one time, and show the
 * proposal as started. The proposal message loses its button.
 */
async function linkSideCaseThread(
  context: ConnectorSideCaseContext,
  input: Readonly<{
    parked: ParkedSlackSideCase;
    proposal: SlackSideCaseProposal;
    token: string;
    threadTs: string;
    starter: SlackUserId;
  }>,
): Promise<StepResult<object>> {
  if (input.parked.linkTs !== null && input.proposal.status === "started")
    return { ok: true };
  const source = input.parked.command.event;
  const threadUrl = await readSlackPermalink({
    token: input.token,
    channelId: source.channelId,
    messageTs: input.threadTs,
  });
  if (!threadUrl.ok) return { ok: false, reason: threadUrl.error.code };
  if (input.parked.linkTs === null) {
    if (!(await isActorExecutionActive(context.storage.sql, context.scope)))
      return { ok: false, reason: "connector_placement_conflict" };
    const posted = await postSlackSideCaseMessage({
      token: input.token,
      channelId: source.channelId,
      threadTs: source.threadTs,
      message: slackSideCaseLinkMessage(
        input.proposal,
        input.starter,
        threadUrl.value,
      ),
    });
    if (!posted.ok) return { ok: false, reason: posted.error.code };
    recordPost(context, input.proposal.proposalId, "link", posted.value);
  }
  // The proposal shows the start. A failed change leaves the button, and a
  // later click answers that the side Case started.
  if (input.parked.proposalTs !== null)
    await updateSlackSideCaseMessage({
      token: input.token,
      channelId: source.channelId,
      ts: input.parked.proposalTs,
      message: slackSideCaseStartedMessage(
        input.proposal,
        input.starter,
        threadUrl.value,
      ),
    });
  return { ok: true };
}

type SideCaseStarter = Readonly<{
  userId: NonNullable<SlackCaseCommand["userId"]>;
  principalId: SlackCaseCommand["principalId"];
  requestAuthority: SlackCaseCommand["requestAuthority"];
}>;

/**
 * The person behind a click, as Slack ingress admits a message: a linked
 * Slack identity, an active membership, and a role that may give Pantry work.
 * The request authority is the proposing turn's for this channel, made for
 * this person, and read live. In a DM only its person can start a proposal.
 */
async function resolveSideCaseStarter(
  scope: OrganisationExecutionScope,
  source: SlackCaseCommand,
  slackUserId: SlackUserId,
): Promise<SideCaseStarter | null> {
  if (
    source.requestAuthority.kind === "direct_conversation" &&
    source.event.author !== slackUserId
  )
    return null;
  const member = await resolveSlackLinkedMember(scope.database, {
    organisationId: source.organisationId,
    integrationAccountId: source.integrationAccountId,
    workspaceId: source.event.workspaceId,
    slackUserId,
  });
  const personId = member === null ? null : parsePersonId(member.personId);
  if (member === null || personId === null || member.role === "viewer")
    return null;
  const authority = await refreshSlackRequestAuthority(scope.database, {
    ...source.requestAuthority,
    requesterPersonId: personId,
    role: member.role,
  });
  return authority === null
    ? null
    : {
        userId: member.userId,
        principalId: personId,
        requestAuthority: authority,
      };
}

/** The identities of the new thread's Case and of its first message. */
function sideCaseThreadIdentities(
  source: SlackCaseCommand,
  threadTs: string,
): Readonly<{
  target: Omit<SlackCaseCommand["target"], "placement">;
  event: Pick<SlackCaseCommand["event"], "sessionId" | "threadKey">;
}> | null {
  const event = { ...source.event, threadTs, messageTs: threadTs };
  const target = deriveSlackCaseRouteIdentities(
    source.integrationAccountId,
    event,
  );
  const sessionId = deriveSlackSessionId(
    source.event.workspaceId,
    source.event.channelId,
    threadTs,
  );
  const threadKey = deriveSlackThreadKey(
    source.event.workspaceId,
    source.event.channelId,
    threadTs,
  );
  return target.ok && sessionId.ok && threadKey.ok
    ? {
        target: target.value,
        event: { sessionId: sessionId.value, threadKey: threadKey.value },
      }
    : null;
}

/**
 * Pin the new thread to the side Case, beside the proposing thread's pin:
 * the same installation, Organisation connection and routing source. A
 * person's reply in the new thread then reaches the side Case. A pin that
 * exists stays, and it must name the side Case.
 */
async function pinSideCaseThread(
  context: ConnectorSideCaseContext,
  source: SlackCaseCommand,
  input: Readonly<{ threadTs: string; caseId: string; now: number }>,
): Promise<boolean> {
  const installation = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: context.env.PANTRY_DEPLOYMENT_PROFILE,
    appId: context.env.SLACK_APP_ID,
  });
  if (!installation.ok) return false;
  const pinned = await context.env.DB.batch<{ readonly caseId: unknown }>([
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO slack_thread_case_pin (
         installation_id, channel_id, root_message_ts, connection_id,
         organisation_id, integration_account_id, case_id,
         routing_source_kind, routing_source_revision, pinned_at
       )
       SELECT pin.installation_id, pin.channel_id, ?, pin.connection_id,
              pin.organisation_id, pin.integration_account_id, ?,
              pin.routing_source_kind, pin.routing_source_revision, ?
       FROM slack_thread_case_pin AS pin
       JOIN slack_installation AS installation
         ON installation.installation_id = pin.installation_id
       JOIN slack_organisation_connection AS connection
         ON connection.installation_id = pin.installation_id
        AND connection.connection_id = pin.connection_id
       WHERE pin.channel_id = ? AND pin.root_message_ts = ?
         AND pin.organisation_id = ? AND pin.integration_account_id = ?
         AND installation.environment = ? AND installation.app_id = ?
         AND installation.workspace_id = ? AND installation.lifecycle = 'active'
         AND connection.lifecycle = 'active'`,
    ).bind(
      input.threadTs,
      input.caseId,
      input.now,
      source.event.channelId,
      source.event.threadTs,
      source.organisationId,
      source.integrationAccountId,
      installation.value.environment,
      installation.value.appId,
      source.event.workspaceId,
    ),
    context.env.DB.prepare(
      `SELECT pin.case_id AS caseId
       FROM slack_thread_case_pin AS pin
       JOIN slack_installation AS installation
         ON installation.installation_id = pin.installation_id
       WHERE pin.channel_id = ? AND pin.root_message_ts = ?
         AND pin.organisation_id = ? AND pin.integration_account_id = ?
         AND installation.environment = ? AND installation.app_id = ?
         AND installation.workspace_id = ?`,
    ).bind(
      source.event.channelId,
      input.threadTs,
      source.organisationId,
      source.integrationAccountId,
      installation.value.environment,
      installation.value.appId,
      source.event.workspaceId,
    ),
  ]);
  const rows = pinned[1]?.results ?? [];
  return rows.length === 1 && rows[0]?.caseId === input.caseId;
}

/** The bot credential of the proposing thread, which the new thread shares. */
async function threadToken(
  context: ConnectorSideCaseContext,
  source: SlackCaseCommand,
): Promise<string | null> {
  const installation = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: context.env.PANTRY_DEPLOYMENT_PROFILE,
    appId: context.env.SLACK_APP_ID,
  });
  const organisationId = parseOrganisationId(source.organisationId);
  const workspaceId = parseWorkspaceId(source.event.workspaceId);
  const channelId = parseChannelId(source.event.channelId);
  if (
    !installation.ok ||
    !organisationId.ok ||
    !workspaceId.ok ||
    !channelId.ok
  )
    return null;
  const token = await resolveActiveSlackThreadCredential({
    env: context.env,
    keys: context.env,
    installationIdentity: installation.value,
    organisationId: organisationId.value,
    workspaceId: workspaceId.value,
    channelId: channelId.value,
    rootMessageTs: source.event.threadTs,
  });
  return token.ok && token.value.kind === "bearer" ? token.value.value : null;
}

function recordPost(
  context: ConnectorSideCaseContext,
  proposalId: string,
  post: Parameters<typeof recordSlackSideCasePost>[2],
  ts: string,
): void {
  context.storage.transactionSync(
    recordSlackSideCasePost.bind(
      null,
      context.storage.sql,
      proposalId,
      post,
      ts,
    ),
  );
}

function refused(code: SlackSideCaseStartRefusal): SlackSideCaseStartOutcome {
  return { kind: "refused", code };
}

function failed(reason: string): SlackSideCaseStartOutcome {
  return { kind: "failed", reason };
}
