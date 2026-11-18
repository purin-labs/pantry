/**
 * Side Cases in Slack (Plan 74, Phase 2). An agent in a Slack thread proposes
 * separate work that it found. The proposal is one message in the thread
 * with a Start button. A person who starts it gets a new thread in the same
 * channel, or in the same DM, and that thread is a new Case whose first
 * message is the agent's brief. The agent never starts it.
 *
 * The title and the brief are model output of the proposing turn, so the
 * proposal keeps that turn's flow binding. Each post of them passes the
 * destination check of the channel, and each turn of the side Case admits the
 * binding as an observation, so every restriction of the proposing turn stays
 * with the new thread.
 */
import type { OrganisationDatabase } from "../database-handles";
import type { Env } from "../env";
import {
  isSideCaseProposalId,
  isUserId,
  type UserId,
} from "@seams/control-api";
import type { HarnessTurnLease } from "@seams/contracts";
import { isNonNegativeInteger, isString } from "@seams/std";

import { decideStoredFlowConversationSink } from "../actors/case-conversation-sink";
import {
  continuesOwnClaim,
  sideCasePhase,
  writeSideCaseTransition,
} from "../chat/side-case-transition";
import {
  ACTIVE_PLACEMENT,
  admitSideCaseObservation,
  isValidSideCaseContent,
  placementBindings,
  SIDE_CASE_LIFETIME_MS,
  SIDE_CASE_OPEN_LIMIT,
  sideCaseContentDigest,
  sideCaseProposalId,
} from "../chat/side-cases";
import { parsePersonId, type PersonId } from "../data/person-authz";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { FlowBinding } from "../policy/information-flow";
import { parseSlackUserId, type SlackUserId } from "./events";

/** The `action_id` of the Start button of a proposal message. */
export const SLACK_SIDE_CASE_START_ACTION = "satyr_side_case_start";

/** Added to the harness instructions of each turn of a Slack side Case. */
export const SLACK_SIDE_CASE_HARNESS_INSTRUCTION =
  "This thread started from a side Case proposal in another Slack thread. The first message is that proposal's brief. Do the work that the brief describes. Approvals and effects in the other thread do not authorize actions here.";

export type SlackSideCaseStatus = "open" | "starting" | "started";

export type SlackSideCaseProposal = Readonly<{
  proposalId: string;
  sourceCaseId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  connectorId: string;
  workspaceId: string;
  channelId: string;
  /** The root of the thread where the agent proposed it. */
  sourceThreadTs: string;
  requestedByPersonId: PersonId;
  title: string;
  brief: string;
  contentDigest: string;
  /** The binding of the proposing turn when the agent made the proposal. */
  flowBinding: FlowBinding;
  status: SlackSideCaseStatus;
  /** The person who started it, once a person clicked Start. */
  decidedByUserId: UserId | null;
  decidedBySlackUserId: SlackUserId | null;
  /** The root of the new thread, once Pantry posted it. */
  destinationThreadTs: string | null;
  destinationCaseId: string | null;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number;
}>;

/**
 * Stores one proposal of the agent. A repeated call of the same turn with the
 * same content returns the first proposal. A thread's Case holds at most
 * three open proposals; a fourth one is not stored.
 */
export async function storeSlackSideCaseProposal(
  execution: OrganisationExecutionScope,
  input: Readonly<{
    sourceCaseId: string;
    sourceSessionId: string;
    sourceTurnId: string;
    connectorId: string;
    workspaceId: string;
    channelId: string;
    sourceThreadTs: string;
    requestedByPersonId: PersonId;
    title: string;
    brief: string;
    flowBinding: FlowBinding;
    now: number;
  }>,
): Promise<
  | Readonly<{ kind: "proposed"; proposal: SlackSideCaseProposal }>
  | Readonly<{ kind: "limit_reached" }>
> {
  if (!isValidSideCaseContent(input)) throw new Error("side_case_invalid");
  const proposalId = await sideCaseProposalId({
    sessionId: input.sourceSessionId,
    turnId: input.sourceTurnId,
    title: input.title,
    brief: input.brief,
  });
  await execution.database
    .prepare(
      `INSERT OR IGNORE INTO side_case_proposal (organisation_id, proposal_id, source_kind,
        source_case_id, source_session_id, source_turn_id, source_connector_id,
        source_workspace_id, source_channel_id, source_thread_ts, requested_by_person_id,
        title, brief, content_digest, flow_binding_json, status, created_at, expires_at)
      SELECT ?, ?, 'slack_thread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?
      WHERE (SELECT COUNT(*) FROM side_case_proposal WHERE organisation_id = ?
          AND source_case_id = ? AND status = 'open' AND expires_at > ?) < ?
        AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      execution.organisationId,
      proposalId,
      input.sourceCaseId,
      input.sourceSessionId,
      input.sourceTurnId,
      input.connectorId,
      input.workspaceId,
      input.channelId,
      input.sourceThreadTs,
      input.requestedByPersonId,
      input.title,
      input.brief,
      await sideCaseContentDigest(input),
      JSON.stringify(input.flowBinding.toJSON()),
      input.now,
      input.now + SIDE_CASE_LIFETIME_MS,
      execution.organisationId,
      input.sourceCaseId,
      input.now,
      SIDE_CASE_OPEN_LIMIT,
      ...placementBindings(execution),
    )
    .run();
  if (!(await execution.isActive()))
    throw new Error("side_case_placement_conflict");
  const stored = await readSlackSideCaseProposal(
    execution.database,
    execution.organisationId,
    proposalId,
  );
  if (stored === null) return { kind: "limit_reached" };
  if (
    stored.sourceCaseId !== input.sourceCaseId ||
    stored.sourceTurnId !== input.sourceTurnId ||
    stored.channelId !== input.channelId ||
    stored.sourceThreadTs !== input.sourceThreadTs
  )
    throw new Error("side_case_identity_conflict");
  return { kind: "proposed", proposal: stored };
}

export async function readSlackSideCaseProposal(
  db: OrganisationDatabase,
  organisationId: string,
  proposalId: string,
): Promise<SlackSideCaseProposal | null> {
  if (!isSideCaseProposalId(proposalId)) return null;
  const raw = await db
    .prepare(
      "SELECT * FROM side_case_proposal WHERE organisation_id = ? AND proposal_id = ? AND source_kind = 'slack_thread'",
    )
    .bind(organisationId, proposalId)
    .first();
  return raw === null ? null : parseSlackProposalRow(raw);
}

export type SlackSideCaseStarter = Readonly<{
  userId: UserId;
  slackUserId: SlackUserId;
}>;

export type SlackSideCaseClaim =
  | Readonly<{ ok: true; proposal: SlackSideCaseProposal }>
  | Readonly<{
      ok: false;
      code: "side_case_expired" | "side_case_started_by_another";
    }>;

/**
 * Claims an open proposal for its starter. A claim by the same person again
 * returns the claimed proposal, so a second click finishes the first start.
 * One person starts a proposal, and only one time. When a start's lease ends
 * before it finishes, another person's click claims the proposal again.
 */
export async function claimSlackSideCaseStart(
  execution: OrganisationExecutionScope,
  proposal: SlackSideCaseProposal,
  starter: SlackSideCaseStarter,
  now: number,
): Promise<SlackSideCaseClaim> {
  const phase = sideCasePhase(proposal, now);
  if (phase === "expired") return { ok: false, code: "side_case_expired" };
  if (phase === "open" && !continuesOwnClaim(proposal, starter.userId)) {
    const moved = await writeSideCaseTransition(
      execution,
      "slack_thread",
      proposal,
      {
        event: "claim",
        userId: starter.userId,
        slackUserId: starter.slackUserId,
        destination: null,
      },
      now,
    );
    if (!moved.ok && moved.error === "side_case_placement_conflict")
      throw new Error("side_case_placement_conflict");
  }
  const claimed = await readSlackSideCaseProposal(
    execution.database,
    execution.organisationId,
    proposal.proposalId,
  );
  if (claimed === null) throw new Error("side_case_unavailable");
  if (claimed.status === "open") return { ok: false, code: "side_case_expired" };
  return claimed.decidedByUserId === starter.userId &&
    claimed.decidedBySlackUserId === starter.slackUserId
    ? { ok: true, proposal: claimed }
    : { ok: false, code: "side_case_started_by_another" };
}

/**
 * Records the new thread of a claimed proposal. The thread's root names the
 * new Case, so a repeated call with the same root changes nothing.
 */
export async function recordSlackSideCaseDestination(
  execution: OrganisationExecutionScope,
  proposal: SlackSideCaseProposal,
  destination: Readonly<{ threadTs: string; caseId: string }>,
): Promise<SlackSideCaseProposal> {
  await execution.database
    .prepare(
      `UPDATE side_case_proposal SET destination_thread_ts = ?, destination_case_id = ?
      WHERE organisation_id = ? AND proposal_id = ? AND source_kind = 'slack_thread'
        AND status = 'starting' AND decided_by_user_id = ? AND decided_at = ?
        AND destination_case_id IS NULL AND ${ACTIVE_PLACEMENT}`,
    )
    .bind(
      destination.threadTs,
      destination.caseId,
      execution.organisationId,
      proposal.proposalId,
      proposal.decidedByUserId,
      proposal.decidedAt,
      ...placementBindings(execution),
    )
    .run();
  if (!(await execution.isActive()))
    throw new Error("side_case_placement_conflict");
  const recorded = await readSlackSideCaseProposal(
    execution.database,
    execution.organisationId,
    proposal.proposalId,
  );
  if (
    recorded === null ||
    recorded.destinationThreadTs !== destination.threadTs ||
    recorded.destinationCaseId !== destination.caseId
  )
    throw new Error("side_case_destination_conflict");
  return recorded;
}

/** Marks a side Case started after its first work and its link are kept. */
export async function settleSlackSideCaseStart(
  execution: OrganisationExecutionScope,
  proposal: SlackSideCaseProposal,
  now: number,
): Promise<void> {
  const moved = await writeSideCaseTransition(
    execution,
    "slack_thread",
    proposal,
    { event: "start" },
    now,
  );
  if (!moved.ok && moved.error === "side_case_placement_conflict")
    throw new Error("side_case_placement_conflict");
}

/**
 * Joins the proposing turn's label into this turn's context before
 * inference, so that every output of the side Case carries it. The turn's
 * authority is a person in the proposal's channel, and the label must allow
 * that channel now.
 */
export async function admitSlackSideCaseInformationFlow(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  proposal: SlackSideCaseProposal,
  authorizeCommit: () => void | Promise<void>,
  env: Env,
): Promise<void> {
  const authority = lease.requestAuthority;
  if (
    (authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation") ||
    authority.conversationId !== proposal.channelId ||
    authority.connectorId !== proposal.connectorId
  )
    throw new Error("side_case_forbidden");
  const decision = await decideStoredFlowConversationSink(
    authority,
    proposal.flowBinding,
    proposal.channelId,
    env,
  );
  if (!decision.ok) throw new Error("side_case_forbidden");
  await admitSideCaseObservation(storage, lease, proposal, authorizeCommit);
}

/** A Slack message: blocks, and the text of its notification. */
export type SlackSideCaseMessage = Readonly<{
  text: string;
  blocks: readonly Record<string, unknown>[];
}>;

/**
 * The proposal in the parent thread. The title and the brief are model
 * output, so they are plain text: Slack makes no mention or link of them.
 */
export function slackSideCaseProposalMessage(
  proposal: Pick<SlackSideCaseProposal, "proposalId" | "title" | "brief">,
): SlackSideCaseMessage {
  return {
    text: `Side Case proposed: ${escapeSlackText(proposal.title)}`,
    blocks: [
      contextBlock(
        "Sous Chef proposes this separate work. Start it to open a new thread for it.",
      ),
      { type: "header", text: plainText(proposal.title) },
      { type: "section", text: plainText(proposal.brief) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_SIDE_CASE_START_ACTION,
            value: proposal.proposalId,
            style: "primary",
            text: plainText("Start thread"),
          },
        ],
      },
    ],
  };
}

/** The proposal after a person started it: no button, a link instead. */
export function slackSideCaseStartedMessage(
  proposal: Pick<SlackSideCaseProposal, "title" | "brief">,
  starter: SlackUserId,
  threadUrl: string,
): SlackSideCaseMessage {
  return {
    text: `Side Case started: ${escapeSlackText(proposal.title)}`,
    blocks: [
      { type: "header", text: plainText(proposal.title) },
      { type: "section", text: plainText(proposal.brief) },
      contextBlock(`<@${starter}> started this side Case in <${threadUrl}|a new thread>.`),
    ],
  };
}

/** The first message of the new thread: the proposal and its source. */
export function slackSideCaseThreadMessage(
  proposal: Pick<SlackSideCaseProposal, "title" | "brief">,
  starter: SlackUserId,
  sourceThreadUrl: string,
): SlackSideCaseMessage {
  return {
    text: `Side Case: ${escapeSlackText(proposal.title)}`,
    blocks: [
      { type: "header", text: plainText(proposal.title) },
      { type: "section", text: plainText(proposal.brief) },
      contextBlock(
        `Proposed in <${sourceThreadUrl}|another thread>. <@${starter}> started it. Reply in this thread to continue.`,
      ),
    ],
  };
}

/** The line in the parent thread that links to the new thread. */
export function slackSideCaseLinkMessage(
  proposal: Pick<SlackSideCaseProposal, "title">,
  starter: SlackUserId,
  threadUrl: string,
): SlackSideCaseMessage {
  const line = `<@${starter}> started the side Case “${escapeSlackText(proposal.title)}” in <${threadUrl}|a new thread>.`;
  return { text: line, blocks: [{ type: "section", text: mrkdwn(line) }] };
}

/** Escapes the three characters that Slack reads as markup. */
export function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plainText(text: string): Record<string, unknown> {
  return { type: "plain_text", text, emoji: false };
}

function mrkdwn(text: string): Record<string, unknown> {
  return { type: "mrkdwn", text };
}

function contextBlock(text: string): Record<string, unknown> {
  return { type: "context", elements: [mrkdwn(text)] };
}

/** A stored Slack proposal. A row of a Portal proposal is refused. */
export async function parseSlackProposalRow(
  raw: Record<string, unknown>,
): Promise<SlackSideCaseProposal> {
  const {
    proposal_id: proposalId,
    source_case_id: sourceCaseId,
    source_session_id: sourceSessionId,
    source_turn_id: sourceTurnId,
    source_connector_id: connectorId,
    source_workspace_id: workspaceId,
    source_channel_id: channelId,
    source_thread_ts: sourceThreadTs,
    requested_by_person_id: requestedByPersonId,
    title,
    brief,
    content_digest: contentDigest,
    flow_binding_json: flowBindingJson,
    status,
    decided_by_user_id: decidedByUserId,
    decided_by_slack_user_id: decidedBySlackUserId,
    destination_thread_ts: destinationThreadTs,
    destination_case_id: destinationCaseId,
    created_at: createdAt,
    decided_at: decidedAt,
    expires_at: expiresAt,
  } = raw;
  const requester = parsePersonId(requestedByPersonId);
  if (
    raw.source_kind !== "slack_thread" ||
    !isSideCaseProposalId(proposalId) ||
    typeof sourceCaseId !== "string" ||
    typeof sourceSessionId !== "string" ||
    typeof sourceTurnId !== "string" ||
    typeof connectorId !== "string" ||
    typeof workspaceId !== "string" ||
    typeof channelId !== "string" ||
    typeof sourceThreadTs !== "string" ||
    requester === null ||
    typeof title !== "string" ||
    typeof brief !== "string" ||
    typeof contentDigest !== "string" ||
    typeof flowBindingJson !== "string" ||
    !isSlackSideCaseStatus(status) ||
    !isNonNegativeInteger(createdAt) ||
    !isNonNegativeInteger(expiresAt)
  )
    throw new Error("side_case_storage_invalid");
  const decidedBy = nullable(decidedByUserId, isUserId);
  const decidedBySlack = nullable(decidedBySlackUserId, isSlackUserId);
  const destinationThread = nullable(destinationThreadTs, isString);
  const destinationCase = nullable(destinationCaseId, isString);
  const decided = nullable(decidedAt, isNonNegativeInteger);
  if (
    decidedBy === undefined ||
    decidedBySlack === undefined ||
    destinationThread === undefined ||
    destinationCase === undefined ||
    decided === undefined
  )
    throw new Error("side_case_storage_invalid");
  const binding = await FlowBinding.restore(JSON.parse(flowBindingJson));
  if (
    !binding.ok ||
    (await sideCaseContentDigest({ title, brief })) !== contentDigest
  )
    throw new Error("side_case_storage_invalid");
  return {
    proposalId,
    sourceCaseId,
    sourceSessionId,
    sourceTurnId,
    connectorId,
    workspaceId,
    channelId,
    sourceThreadTs,
    requestedByPersonId: requester,
    title,
    brief,
    contentDigest,
    flowBinding: binding.value,
    status,
    decidedByUserId: decidedBy,
    decidedBySlackUserId: decidedBySlack,
    destinationThreadTs: destinationThread,
    destinationCaseId: destinationCase,
    createdAt,
    decidedAt: decided,
    expiresAt,
  };
}

const SLACK_SIDE_CASE_STATUSES: Readonly<Record<SlackSideCaseStatus, true>> = {
  open: true,
  starting: true,
  started: true,
};

function isSlackSideCaseStatus(value: unknown): value is SlackSideCaseStatus {
  return (
    typeof value === "string" && Object.hasOwn(SLACK_SIDE_CASE_STATUSES, value)
  );
}

function isSlackUserId(value: unknown): value is SlackUserId {
  return typeof value === "string" && parseSlackUserId(value, "user").ok;
}

/** The value, null for a stored NULL, or undefined for an invalid value. */
function nullable<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T | null | undefined {
  if (value === null) return null;
  return guard(value) ? value : undefined;
}
