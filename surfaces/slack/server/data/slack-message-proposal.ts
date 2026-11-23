import type {
  GlobalDatabase,
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import { isNonNegativeInteger, sha256Hex } from "@purin-labs/std";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * A plain-text Slack message that a Portal chat agent drafted. It is never
 * posted by the agent: a person sends it, edits it or discards it from the
 * card in the conversation that holds its Case.
 */
type SlackMessageProposalLifecycle =
  | "awaiting_approval"
  | "sending"
  | "sent"
  | "send_failed"
  | "rejected"
  | "expired";

export type SlackMessageProposal = Readonly<{
  organisationId: string;
  proposalId: string;
  caseId: string;
  integrationAccountId: string;
  sessionId: string;
  turnId: string;
  /** What the agent named, such as "#general", before a person chose. */
  channelHint: string | null;
  channelId: string | null;
  body: string;
  bodyDigest: string;
  version: number;
  lifecycleKind: SlackMessageProposalLifecycle;
  sentChannelId: string | null;
  sentMessageTs: string | null;
  failureCode: string | null;
  decidedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}>;

/** One connected channel that a draft may go to. */
export type SlackChannelOption = Readonly<{
  channelId: string;
  /** The channel name from the latest discovery, without "#"; null if unknown. */
  name: string | null;
}>;

export type SlackChannelOptions = Readonly<{
  workspaceId: string;
  workspaceName: string;
  channels: readonly SlackChannelOption[];
}>;

export const SLACK_MESSAGE_MAX_LENGTH = 8000;
const SLACK_MESSAGE_DRAFT_LIFETIME_MS = 24 * 60 * 60_000;
const CASE_DRAFT_LIMIT = 20;
const CHANNEL_OPTION_LIMIT = 50;

type StoreError = Readonly<{ code: "slack_message_store_failed" }>;

const COLUMNS = `organisation_id AS organisationId, proposal_id AS proposalId,
  case_id AS caseId, integration_account_id AS integrationAccountId,
  session_id AS sessionId, turn_id AS turnId, channel_hint AS channelHint,
  channel_id AS channelId, body, body_digest AS bodyDigest, version,
  lifecycle_kind AS lifecycleKind, sent_channel_id AS sentChannelId,
  sent_message_ts AS sentMessageTs, failure_code AS failureCode,
  decided_by_user_id AS decidedByUserId, created_at AS createdAt,
  updated_at AS updatedAt, expires_at AS expiresAt`;

const PLACEMENT_FENCE = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

function fenceBindings(
  scope: OrganisationExecutionScope,
): readonly (string | number)[] {
  return [
    scope.organisationId,
    scope.placement.placementEpoch,
    scope.placement.placementCellId,
    scope.fenceToken,
  ];
}

export function slackMessageBodyDigest(body: string): Promise<string> {
  return sha256Hex(body);
}

/** A channel ID as Slack issues it, such as C0123ABCD. */
export function isSlackChannelId(value: string): boolean {
  return /^[CG][A-Z0-9]{6,20}$/u.test(value);
}

export async function insertSlackMessageProposal(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    proposalId: string;
    caseId: string;
    integrationAccountId: string;
    sessionId: string;
    turnId: string;
    channelHint: string | null;
    channelId: string | null;
    body: string;
    now: number;
  }>,
): Promise<Result<SlackMessageProposal, StoreError>> {
  const bodyDigest = await slackMessageBodyDigest(input.body);
  try {
    const db = input.scope.database.withSession("first-primary");
    const written = await db
      .prepare(
        `INSERT INTO slack_message_proposal (
           organisation_id, proposal_id, case_id, integration_account_id,
           session_id, turn_id, channel_hint, channel_id, body, body_digest,
           version, lifecycle_kind, created_at, updated_at, expires_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'awaiting_approval', ?, ?, ?
         WHERE ${PLACEMENT_FENCE}
         ON CONFLICT (organisation_id, proposal_id) DO NOTHING`,
      )
      .bind(
        input.scope.organisationId,
        input.proposalId,
        input.caseId,
        input.integrationAccountId,
        input.sessionId,
        input.turnId,
        input.channelHint,
        input.channelId,
        input.body,
        bodyDigest,
        input.now,
        input.now,
        input.now + SLACK_MESSAGE_DRAFT_LIFETIME_MS,
        ...fenceBindings(input.scope),
      )
      .run();
    const stored = await readSlackMessageProposal({
      db,
      organisationId: input.scope.organisationId,
      proposalId: input.proposalId,
    });
    // A repeated tool call with the same identity keeps the first draft, and
    // only a draft with the same text counts as the same call.
    if (
      stored === null ||
      stored.caseId !== input.caseId ||
      stored.bodyDigest !== bodyDigest ||
      (written.meta.changes !== 1 && stored.turnId !== input.turnId)
    )
      return storeFailed();
    return { ok: true, value: stored };
  } catch {
    return storeFailed();
  }
}

export async function readSlackMessageProposal(
  input: Readonly<{
    db:
      | Pick<OrganisationDatabase, "prepare">
      | Pick<OrganisationDatabaseSession, "prepare">;
    organisationId: string;
    proposalId: string;
  }>,
): Promise<SlackMessageProposal | null> {
  const row = await input.db
    .prepare(
      `SELECT ${COLUMNS} FROM slack_message_proposal
       WHERE organisation_id = ? AND proposal_id = ?`,
    )
    .bind(input.organisationId, input.proposalId)
    .first<Record<string, unknown>>();
  return row === null ? null : parseProposalRow(row);
}

/** The drafts of one Case, oldest first. A draft past its time is expired. */
export async function listSlackMessageProposalsForCase(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: string;
    caseId: string;
    now: number;
  }>,
): Promise<readonly SlackMessageProposal[]> {
  const rows = await input.db
    .prepare(
      `SELECT ${COLUMNS} FROM slack_message_proposal
       WHERE organisation_id = ? AND case_id = ?
       ORDER BY created_at DESC, proposal_id LIMIT ?`,
    )
    .bind(input.organisationId, input.caseId, CASE_DRAFT_LIMIT)
    .all<Record<string, unknown>>();
  const proposals: SlackMessageProposal[] = [];
  for (const row of rows.results ?? []) {
    const parsed = parseProposalRow(row);
    if (parsed !== null) proposals.push(withExpiry(parsed, input.now));
  }
  return proposals.reverse();
}

/** A waiting draft past its expiry reads as expired; the row changes on use. */
export function withExpiry(
  proposal: SlackMessageProposal,
  now: number,
): SlackMessageProposal {
  return proposal.lifecycleKind === "awaiting_approval" &&
    now >= proposal.expiresAt
    ? { ...proposal, lifecycleKind: "expired" }
    : proposal;
}

/**
 * Replaces the text or the channel of a draft that is not sent. The version
 * goes up, so a Send that was prepared for the old text is refused.
 */
export async function editSlackMessageProposal(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    proposalId: string;
    expectedVersion: number;
    body: string;
    channelId: string | null;
    now: number;
  }>,
): Promise<Result<SlackMessageProposal, StoreError | ConflictError>> {
  const bodyDigest = await slackMessageBodyDigest(input.body);
  return changeProposal(
    input.scope,
    input.proposalId,
    `UPDATE slack_message_proposal
     SET body = ?, body_digest = ?, channel_id = ?, version = version + 1,
       lifecycle_kind = 'awaiting_approval', failure_code = NULL, updated_at = ?
     WHERE organisation_id = ? AND proposal_id = ? AND version = ?
       AND lifecycle_kind IN ('awaiting_approval', 'send_failed')
       AND expires_at > ? AND ${PLACEMENT_FENCE}`,
    [
      input.body,
      bodyDigest,
      input.channelId,
      input.now,
      input.scope.organisationId,
      input.proposalId,
      input.expectedVersion,
      input.now,
      ...fenceBindings(input.scope),
    ],
  );
}

type ConflictError = Readonly<{ code: "slack_message_conflict" }>;

/**
 * Claims a draft for one Send of an exact version and text. A draft whose
 * earlier Send failed or did not finish can be claimed again: the Slack
 * delivery is keyed by the proposal version, so it posts at most once.
 */
export async function claimSlackMessageSend(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    proposalId: string;
    version: number;
    bodyDigest: string;
    channelId: string;
    decidedByUserId: string;
    now: number;
  }>,
): Promise<Result<SlackMessageProposal, StoreError | ConflictError>> {
  return changeProposal(
    input.scope,
    input.proposalId,
    `UPDATE slack_message_proposal
     SET lifecycle_kind = 'sending', channel_id = ?, failure_code = NULL,
       decided_by_user_id = ?, updated_at = ?
     WHERE organisation_id = ? AND proposal_id = ? AND version = ?
       AND body_digest = ?
       AND lifecycle_kind IN ('awaiting_approval', 'send_failed', 'sending')
       AND (lifecycle_kind <> 'awaiting_approval' OR expires_at > ?)
       AND ${PLACEMENT_FENCE}`,
    [
      input.channelId,
      input.decidedByUserId,
      input.now,
      input.scope.organisationId,
      input.proposalId,
      input.version,
      input.bodyDigest,
      input.now,
      ...fenceBindings(input.scope),
    ],
  );
}

export async function settleSlackMessageSend(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    proposalId: string;
    version: number;
    outcome:
      | Readonly<{ kind: "sent"; channelId: string; messageTs: string }>
      | Readonly<{ kind: "failed"; code: string; final: boolean }>;
    now: number;
  }>,
): Promise<Result<SlackMessageProposal, StoreError | ConflictError>> {
  const sent = input.outcome.kind === "sent";
  // Slack refused a final failure, so its delivery key is spent. The next
  // Send of this draft gets a new version and with it a new key.
  const nextVersion =
    input.outcome.kind === "failed" && input.outcome.final
      ? input.version + 1
      : input.version;
  return changeProposal(
    input.scope,
    input.proposalId,
    `UPDATE slack_message_proposal
     SET lifecycle_kind = ?, sent_channel_id = ?, sent_message_ts = ?,
       failure_code = ?, version = ?, updated_at = ?
     WHERE organisation_id = ? AND proposal_id = ? AND version = ?
       AND lifecycle_kind = 'sending' AND ${PLACEMENT_FENCE}`,
    [
      sent ? "sent" : "send_failed",
      input.outcome.kind === "sent" ? input.outcome.channelId : null,
      input.outcome.kind === "sent" ? input.outcome.messageTs : null,
      input.outcome.kind === "failed" ? input.outcome.code : null,
      nextVersion,
      input.now,
      input.scope.organisationId,
      input.proposalId,
      input.version,
      ...fenceBindings(input.scope),
    ],
  );
}

export async function rejectSlackMessageProposal(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    proposalId: string;
    version: number;
    decidedByUserId: string;
    now: number;
  }>,
): Promise<Result<SlackMessageProposal, StoreError | ConflictError>> {
  return changeProposal(
    input.scope,
    input.proposalId,
    `UPDATE slack_message_proposal
     SET lifecycle_kind = 'rejected', failure_code = NULL,
       decided_by_user_id = ?, updated_at = ?
     WHERE organisation_id = ? AND proposal_id = ? AND version = ?
       AND lifecycle_kind IN ('awaiting_approval', 'send_failed')
       AND ${PLACEMENT_FENCE}`,
    [
      input.decidedByUserId,
      input.now,
      input.scope.organisationId,
      input.proposalId,
      input.version,
      ...fenceBindings(input.scope),
    ],
  );
}

async function changeProposal(
  scope: OrganisationExecutionScope,
  proposalId: string,
  sql: string,
  bindings: readonly (string | number | null)[],
): Promise<Result<SlackMessageProposal, StoreError | ConflictError>> {
  try {
    const db = scope.database.withSession("first-primary");
    const changed = await db
      .prepare(sql)
      .bind(...bindings)
      .run();
    if (changed.meta.changes !== 1)
      return { ok: false, error: { code: "slack_message_conflict" } };
    const stored = await readSlackMessageProposal({
      db,
      organisationId: scope.organisationId,
      proposalId,
    });
    return stored === null ? storeFailed() : { ok: true, value: stored };
  } catch {
    return storeFailed();
  }
}

/**
 * The channels that the organisation connected in this Slack workspace. Only
 * these can receive a drafted message. The connection lives in the global
 * database; the account name and the channel names from the latest discovery
 * live in the Organisation's regional database. A channel without a known
 * name shows by its ID.
 */
export async function readSlackChannelOptions(
  input: Readonly<{
    globalDatabase: GlobalDatabase;
    db: OrganisationDatabase;
    organisationId: string;
    integrationAccountId: string;
  }>,
): Promise<SlackChannelOptions | null> {
  const connected = await input.globalDatabase
    .prepare(
      `SELECT installation.workspace_id AS workspaceId,
              channel.channel_id AS channelId
       FROM slack_organisation_connection AS connection
       JOIN slack_installation AS installation
         ON installation.installation_id = connection.installation_id
        AND installation.lifecycle = 'active'
       JOIN slack_channel_default AS channel
         ON channel.installation_id = connection.installation_id
        AND channel.connection_id = connection.connection_id
       WHERE connection.organisation_id = ?
         AND connection.integration_account_id = ?
         AND connection.lifecycle = 'active'
       ORDER BY channel.channel_id LIMIT ?`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      CHANNEL_OPTION_LIMIT,
    )
    .all<Record<string, unknown>>();
  let workspaceId: string | null = null;
  const channelIds: string[] = [];
  for (const row of connected.results ?? []) {
    if (
      typeof row.workspaceId !== "string" ||
      typeof row.channelId !== "string" ||
      (workspaceId !== null && workspaceId !== row.workspaceId)
    )
      return null;
    workspaceId = row.workspaceId;
    channelIds.push(row.channelId);
  }
  if (workspaceId === null) return null;
  const [account, labels] = await Promise.all([
    input.db
      .prepare(
        `SELECT display_name AS name FROM integration_account
         WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(input.organisationId, input.integrationAccountId)
      .first<Record<string, unknown>>(),
    input.db
      .prepare(
        `SELECT resource.provider_resource_id AS channelId,
                resource.display_label AS label
         FROM provider_discovered_resource AS resource
         JOIN provider_resource_snapshot AS snapshot
           ON snapshot.snapshot_revision = resource.snapshot_revision
         WHERE snapshot.organisation_id = ?
           AND snapshot.integration_account_id = ?
         ORDER BY snapshot.created_at DESC LIMIT 1000`,
      )
      .bind(input.organisationId, input.integrationAccountId)
      .all<Record<string, unknown>>(),
  ]);
  if (account === null || typeof account.name !== "string") return null;
  // The newest snapshot names a channel first; an older name never wins.
  const names = new Map<string, string>();
  for (const row of labels.results ?? []) {
    if (
      typeof row.channelId === "string" &&
      typeof row.label === "string" &&
      row.label.length > 0 &&
      !names.has(row.channelId)
    )
      names.set(row.channelId, row.label.replace(/^#/u, ""));
  }
  return {
    workspaceId,
    workspaceName: account.name,
    channels: channelIds.map((channelId) => ({
      channelId,
      name: names.get(channelId) ?? null,
    })),
  };
}

/** The connected channel that a name or an ID from the agent points to. */
export function matchSlackChannel(
  options: SlackChannelOptions,
  hint: string,
): SlackChannelOption | null {
  const wanted = hint.trim().replace(/^#/u, "").toLowerCase();
  if (wanted.length === 0) return null;
  for (const channel of options.channels) {
    if (
      channel.channelId.toLowerCase() === wanted ||
      channel.name?.toLowerCase() === wanted
    )
      return channel;
  }
  return null;
}

function storeFailed(): { ok: false; error: StoreError } {
  return { ok: false, error: { code: "slack_message_store_failed" } };
}

const LIFECYCLES: Readonly<Record<SlackMessageProposalLifecycle, true>> = {
  awaiting_approval: true,
  sending: true,
  sent: true,
  send_failed: true,
  rejected: true,
  expired: true,
};

function isLifecycle(value: unknown): value is SlackMessageProposalLifecycle {
  return typeof value === "string" && Object.hasOwn(LIFECYCLES, value);
}

function parseProposalRow(
  row: Record<string, unknown>,
): SlackMessageProposal | null {
  if (
    typeof row.organisationId !== "string" ||
    typeof row.proposalId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.integrationAccountId !== "string" ||
    typeof row.sessionId !== "string" ||
    typeof row.turnId !== "string" ||
    !nullableString(row.channelHint) ||
    !nullableString(row.channelId) ||
    typeof row.body !== "string" ||
    typeof row.bodyDigest !== "string" ||
    !isNonNegativeInteger(row.version) ||
    !isLifecycle(row.lifecycleKind) ||
    !nullableString(row.sentChannelId) ||
    !nullableString(row.sentMessageTs) ||
    !nullableString(row.failureCode) ||
    !nullableString(row.decidedByUserId) ||
    !isNonNegativeInteger(row.createdAt) ||
    !isNonNegativeInteger(row.updatedAt) ||
    !isNonNegativeInteger(row.expiresAt)
  )
    return null;
  return {
    organisationId: row.organisationId,
    proposalId: row.proposalId,
    caseId: row.caseId,
    integrationAccountId: row.integrationAccountId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    channelHint: row.channelHint,
    channelId: row.channelId,
    body: row.body,
    bodyDigest: row.bodyDigest,
    version: row.version,
    lifecycleKind: row.lifecycleKind,
    sentChannelId: row.sentChannelId,
    sentMessageTs: row.sentMessageTs,
    failureCode: row.failureCode,
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
