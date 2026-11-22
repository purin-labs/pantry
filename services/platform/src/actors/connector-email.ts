import type { SqlStorage } from "@cloudflare/workers-types";

import {
  parseMailboxProcessingPauseReason,
  type MailboxProcessingPauseReason,
  type MailboxIngressDebounce,
} from "../data/email-mailbox";
import { compareGmailHistoryIds } from "../mail/gmail-adapter";
import type { Result } from "@purin-labs/kernel/result";
import { assertNever } from "@purin-labs/std";
import { createMailOrganizationSchema } from "../mail-inbox/store";
import { createEmailCommerceSchema } from "../mail-inbox/supplier-context";
import {
  createEmailProposalFlowSchema,
  nextEmailCaseContextCollectionDraftCleanupAt,
} from "./email-case-context-collection-evidence";
import { createEmailProposalMemorySchema } from "./email-proposal-memory";
import { createEmailProposalSourceSchema } from "./email-proposal-sources";
/**
 * Mailbox-addressed Connector runtime state. The Connector is the only
 * runtime coordinator for one connected mailbox: it owns the authoritative
 * Gmail history cursor, notification dedupe, push coalescing state, runtime
 * policy counters, token reservations, the open-Case set, and admission
 * order. Rows here hold identifiers, digests, counters, and instants only —
 * never subjects, addresses, bodies, or attachment bytes.
 */

export const EMAIL_EVALUATION_INTERVAL_MS = 30_000;

export type EmailIngressLimits = {
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxAttachmentBytes: number;
  readonly debounce: MailboxIngressDebounce;
};

export type EmailProcessingState =
  | { readonly kind: "waiting" }
  | { readonly kind: "scheduled"; readonly at: number }
  | { readonly kind: "evaluating"; readonly startedAt: number }
  | {
      readonly kind: "paused";
      readonly reason: MailboxProcessingPauseReason;
      readonly pausedAt: number;
      readonly policyVersion: number;
    };

export type EmailRuntimeSnapshot = {
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly policyVersion: number;
  readonly limits: EmailIngressLimits;
  readonly activationFloor: string;
  readonly acceptedHistoryId: string;
  readonly highestObservedHistoryId: string;
  readonly watchExpiresAt: number | null;
  readonly processing: EmailProcessingState;
  readonly lastEvaluationStartedAt: number | null;
  readonly disabledAt: number | null;
};

type EmailRuntimeError = { readonly code: string };

export type EmailCaseContextDiscoveryWork = Readonly<{
  organisationId: string;
  integrationAccountId: string;
  providerMessageId: string;
  caseId: string;
  threadId: string;
  messageIds: readonly string[];
  policyVersion: number;
  admittedAt: number;
  attempts: number;
  availableAt: number;
}>;

const EMAIL_CASE_CONTEXT_DISCOVERY_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;

/**
 * Creates the tables of the mailbox. The Eval level of the Connector gives
 * the tables of its runs, which keep their place in this order.
 */
export function createConnectorEmailSchema(
  sql: SqlStorage,
  createEvalSchema: (sql: SqlStorage) => void,
): void {
  createEmailProposalFlowSchema(sql);
  createEmailProposalMemorySchema(sql);
  createEmailProposalSourceSchema(sql);
  createEvalSchema(sql);
  createMailOrganizationSchema(sql);
  createEmailCommerceSchema(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_runtime (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    organisation_id TEXT NOT NULL,
    integration_account_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    limits_json TEXT NOT NULL,
    activation_floor TEXT NOT NULL,
    accepted_history_id TEXT NOT NULL,
    highest_observed_history_id TEXT NOT NULL,
    watch_expires_at INTEGER,
    processing_json TEXT NOT NULL,
    last_evaluation_started_at INTEGER,
    disabled_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_notification (
    notification_id TEXT PRIMARY KEY,
    observed_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_message (
    provider_message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('admitted', 'skipped')),
    policy_version INTEGER NOT NULL,
    admitted_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_email_message_admitted
    ON connector_email_message (disposition, admitted_at)`);
  // A thread keeps its Case for good. Nothing writes `closed_at`; the reply
  // turn queue says which threads are in progress.
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_case (
    case_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_reservation (
    reservation_id TEXT PRIMARY KEY,
    utc_day TEXT NOT NULL,
    tokens INTEGER NOT NULL CHECK (tokens > 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released')),
    settled_tokens INTEGER,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_email_reservation_day
    ON connector_email_reservation (utc_day, state)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_pause_receipt (
    receipt_key TEXT PRIMARY KEY,
    reason_json TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    accepted_history_id TEXT NOT NULL,
    paused_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_maintenance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    last_pass_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_watch_cleanup (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    available_at INTEGER NOT NULL CHECK (available_at >= 0)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_case_context_discovery (
    integration_account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    organisation_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_ids_json TEXT NOT NULL CHECK (json_valid(message_ids_json)),
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    PRIMARY KEY (integration_account_id, provider_message_id)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_email_case_context_discovery_due
    ON connector_email_case_context_discovery (available_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_draft (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    case_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    draft_message_id TEXT NOT NULL,
    triggering_message_id TEXT NOT NULL,
    target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    state TEXT NOT NULL CHECK (
      state IN (
        'awaiting_approval', 'send_indeterminate', 'sent', 'invalidated',
        'cleanup_pending', 'deleted', 'cleanup_unreachable'
      )
    ),
    approved_snapshot_digest TEXT CHECK (
      approved_snapshot_digest IS NULL OR length(approved_snapshot_digest) = 64
    ),
    sent_message_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, version)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_reply_correction (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 1),
    case_id TEXT NOT NULL,
    corrected_version INTEGER NOT NULL CHECK (
      corrected_version > 0 AND corrected_version < version
    ),
    corrected_body_digest TEXT NOT NULL CHECK (length(corrected_body_digest) = 64),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    editor_person_id TEXT NOT NULL,
    flow_binding_json TEXT NOT NULL CHECK (json_valid(flow_binding_json)),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, version)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_correction_learning (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 1),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    PRIMARY KEY (proposal_id, version)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_reply_turn (
    provider_message_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_ids_json TEXT NOT NULL CHECK (json_valid(message_ids_json)),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    claimed_by TEXT,
    disposition TEXT CHECK (
      disposition IS NULL OR disposition IN ('reply_now', 'approval_required')
    )
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_email_reply_turn_due
    ON connector_email_reply_turn (available_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_operational_proposal (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    case_id TEXT NOT NULL,
    integration_account_id TEXT NOT NULL,
    target_json TEXT NOT NULL CHECK (json_valid(target_json)),
    target_digest TEXT NOT NULL CHECK (length(target_digest) = 64),
    subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
    state TEXT NOT NULL CHECK (
      state IN (
        'awaiting_approval', 'sent', 'send_indeterminate', 'rejected',
        'expired', 'superseded', 'revoked'
      )
    ),
    approved_snapshot_digest TEXT CHECK (
      approved_snapshot_digest IS NULL OR length(approved_snapshot_digest) = 64
    ),
    nonce_b64 TEXT,
    ciphertext_b64 TEXT,
    content_bytes INTEGER CHECK (content_bytes IS NULL OR content_bytes >= 0),
    sent_message_id TEXT,
    sent_thread_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, version)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_operational_dispatch (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    rfc_message_id TEXT NOT NULL,
    PRIMARY KEY (proposal_id, version)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_email_operational_projection (
    proposal_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version > 0),
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_connector_email_operational_proposal_state
    ON connector_email_operational_proposal (state, expires_at)`);
}

export type EmailDraftOperation = {
  readonly proposalId: string;
  readonly version: number;
  readonly caseId: string;
  readonly threadId: string;
  readonly draftId: string;
  readonly draftMessageId: string;
  readonly triggeringMessageId: string;
  readonly targetDigest: string;
  readonly bodyDigest: string;
  readonly snapshotDigest: string;
  readonly policyVersion: number;
  readonly state: EmailDraftState;
  readonly approvedSnapshotDigest: string | null;
  readonly sentMessageId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type EmailDraftState =
  | "awaiting_approval"
  | "send_indeterminate"
  | "sent"
  | "invalidated"
  | "cleanup_pending"
  | "deleted"
  | "cleanup_unreachable";

function decodeEmailDraftState(raw: string): EmailDraftState {
  switch (raw) {
    case "awaiting_approval":
    case "send_indeterminate":
    case "sent":
    case "invalidated":
    case "cleanup_pending":
    case "deleted":
    case "cleanup_unreachable":
      return raw;
    default:
      throw new Error("connector_email_draft_corrupt");
  }
}

export function readEmailDraftSentMessageId(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): string | null {
  const row = sql
    .exec<{ state: string; sent_message_id: string | null }>(
      "SELECT state, sent_message_id FROM connector_email_draft WHERE proposal_id = ? AND version = ?",
      proposalId,
      version,
    )
    .toArray()[0];
  if (row === undefined) return null;
  decodeEmailDraftState(row.state);
  return row.sent_message_id;
}

export function recordEmailDraftOperation(
  sql: SqlStorage,
  input: Readonly<{
    proposalId: string;
    version: number;
    caseId: string;
    threadId: string;
    draftId: string;
    draftMessageId: string;
    triggeringMessageId: string;
    targetDigest: string;
    bodyDigest: string;
    snapshotDigest: string;
    policyVersion: number;
    expiresAt: number;
    now: number;
  }>,
): void {
  sql.exec(
    `INSERT INTO connector_email_draft (
       proposal_id, version, case_id, thread_id, draft_id, draft_message_id,
       triggering_message_id, target_digest, body_digest, snapshot_digest,
       policy_version, state, approved_snapshot_digest, sent_message_id,
       created_at, expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', NULL, NULL, ?, ?, ?)
     ON CONFLICT (proposal_id, version) DO NOTHING`,
    input.proposalId,
    input.version,
    input.caseId,
    input.threadId,
    input.draftId,
    input.draftMessageId,
    input.triggeringMessageId,
    input.targetDigest,
    input.bodyDigest,
    input.snapshotDigest,
    input.policyVersion,
    input.now,
    input.expiresAt,
    input.now,
  );
}

/**
 * One reviewed edit of a reply draft, recorded with the version it produced.
 *
 * It exists only where the whole history of the body is recorded: the edit
 * was made through review, on the agent's draft or on an earlier recorded
 * edit. `flowBindingJson` is the proposal's own binding as stored, which
 * names every source the draft drew on. The editor wrote into that draft, so
 * their words carry its label.
 */
export type EmailReplyCorrection = Readonly<{
  proposalId: string;
  version: number;
  caseId: string;
  correctedVersion: number;
  correctedBodyDigest: string;
  bodyDigest: string;
  editorPersonId: string;
  flowBindingJson: string;
  recordedAt: number;
}>;

export function recordEmailReplyCorrection(
  sql: SqlStorage,
  correction: EmailReplyCorrection,
): void {
  sql.exec(
    `INSERT INTO connector_email_reply_correction (
       proposal_id, version, case_id, corrected_version, corrected_body_digest,
       body_digest, editor_person_id, flow_binding_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (proposal_id, version) DO NOTHING`,
    correction.proposalId,
    correction.version,
    correction.caseId,
    correction.correctedVersion,
    correction.correctedBodyDigest,
    correction.bodyDigest,
    correction.editorPersonId,
    correction.flowBindingJson,
    correction.recordedAt,
  );
}

/** One recorded correction the mailbox agent has yet to learn from. */
export type EmailCorrectionLearningWork = Readonly<{
  proposalId: string;
  version: number;
  /** The attempt this claim runs, counted from one. */
  attempt: number;
}>;

const EMAIL_CORRECTION_LEARNING_MAX_ATTEMPTS =
  EMAIL_CASE_CONTEXT_DISCOVERY_RETRY_DELAYS_MS.length + 1;

/**
 * How long a claim holds a mail turn's work: one turn's wall time and a
 * margin for the steps after it.
 */
const EMAIL_REPLY_TURN_LEASE_MS = 6 * 60_000;

/** Queues the learning turn for a correction just recorded. */
export function recordEmailCorrectionLearning(
  sql: SqlStorage,
  input: Readonly<{ proposalId: string; version: number; now: number }>,
): void {
  sql.exec(
    `INSERT INTO connector_email_correction_learning (
       proposal_id, version, attempts, available_at
     ) VALUES (?, ?, 0, ?)
     ON CONFLICT (proposal_id, version) DO NOTHING`,
    input.proposalId,
    input.version,
    input.now,
  );
}

export function nextEmailCorrectionLearningAt(sql: SqlStorage): number | null {
  return (
    sql
      .exec<{ available_at: number | null }>(
        "SELECT MIN(available_at) AS available_at FROM connector_email_correction_learning",
      )
      .toArray()[0]?.available_at ?? null
  );
}

/**
 * Claims the next due learning turn and counts the attempt. The claim holds
 * the work for one turn's wall time and a margin. An instance that stops
 * with the turn leaves the work in place, and it is due again when that
 * time ends. Work that has used every attempt is dropped.
 */
export function claimDueEmailCorrectionLearning(
  sql: SqlStorage,
  now: number,
): EmailCorrectionLearningWork | null {
  const rows = sql
    .exec<{ proposal_id: string; version: number; attempts: number }>(
      `SELECT proposal_id, version, attempts
       FROM connector_email_correction_learning
       WHERE available_at <= ?
       ORDER BY available_at, proposal_id, version`,
      now,
    )
    .toArray();
  for (const row of rows) {
    if (row.attempts >= EMAIL_CORRECTION_LEARNING_MAX_ATTEMPTS) {
      sql.exec(
        "DELETE FROM connector_email_correction_learning WHERE proposal_id = ? AND version = ?",
        row.proposal_id,
        row.version,
      );
      continue;
    }
    sql.exec(
      `UPDATE connector_email_correction_learning
       SET attempts = attempts + 1, available_at = ?
       WHERE proposal_id = ? AND version = ?`,
      now + EMAIL_REPLY_TURN_LEASE_MS,
      row.proposal_id,
      row.version,
    );
    return {
      proposalId: row.proposal_id,
      version: row.version,
      attempt: row.attempts + 1,
    };
  }
  return null;
}

export function completeEmailCorrectionLearning(
  sql: SqlStorage,
  work: EmailCorrectionLearningWork,
): void {
  sql.exec(
    "DELETE FROM connector_email_correction_learning WHERE proposal_id = ? AND version = ?",
    work.proposalId,
    work.version,
  );
}

/** Schedules another attempt, or drops the work once its attempts are spent. */
export function retryEmailCorrectionLearning(
  sql: SqlStorage,
  input: Readonly<{ work: EmailCorrectionLearningWork; now: number }>,
): "scheduled" | "exhausted" {
  const delay =
    EMAIL_CASE_CONTEXT_DISCOVERY_RETRY_DELAYS_MS[input.work.attempt - 1];
  if (delay === undefined) {
    completeEmailCorrectionLearning(sql, input.work);
    return "exhausted";
  }
  sql.exec(
    `UPDATE connector_email_correction_learning
     SET available_at = ?
     WHERE proposal_id = ? AND version = ?`,
    input.now + delay,
    input.work.proposalId,
    input.work.version,
  );
  return "scheduled";
}

/**
 * One admitted burst of mail on a thread that the mailbox agent has yet to
 * answer. The row is written with the admission, before any turn runs, and
 * stays until the turn settles. It names messages only.
 */
export type EmailReplyTurnWork = Readonly<{
  /** The newest message of the burst. It names the turn. */
  providerMessageId: string;
  caseId: string;
  threadId: string;
  messageIds: readonly string[];
  /** The attempt this claim runs, counted from one. */
  attempt: number;
  /** What an earlier attempt chose before it stopped, when it got that far. */
  disposition: EmailReplyDisposition | null;
}>;

export type EmailReplyDisposition = "reply_now" | "approval_required";

const EMAIL_REPLY_TURN_MAX_ATTEMPTS =
  EMAIL_CASE_CONTEXT_DISCOVERY_RETRY_DELAYS_MS.length + 1;

/** Queues the reply turn for one admitted burst. */
export function recordEmailReplyTurn(
  sql: SqlStorage,
  input: Readonly<{
    caseId: string;
    threadId: string;
    messageIds: readonly string[];
    now: number;
  }>,
): void {
  const providerMessageId = input.messageIds.at(-1);
  if (providerMessageId === undefined) return;
  sql.exec(
    `INSERT INTO connector_email_reply_turn (
       provider_message_id, case_id, thread_id, message_ids_json, attempts,
       available_at, claimed_by, disposition
     ) VALUES (?, ?, ?, ?, 0, ?, NULL, NULL)
     ON CONFLICT (provider_message_id) DO NOTHING`,
    providerMessageId,
    input.caseId,
    input.threadId,
    JSON.stringify(input.messageIds),
    input.now,
  );
}

/**
 * When the next reply turn is due. A paused or disabled mailbox runs none,
 * so its queued turns wait for the resume without waking the Actor.
 */
export function nextEmailReplyTurnAt(sql: SqlStorage): number | null {
  const runtime = readEmailRuntime(sql);
  if (
    runtime === null ||
    runtime.disabledAt !== null ||
    runtime.processing.kind === "paused"
  )
    return null;
  return (
    sql
      .exec<{ available_at: number | null }>(
        "SELECT MIN(available_at) AS available_at FROM connector_email_reply_turn",
      )
      .toArray()[0]?.available_at ?? null
  );
}

/**
 * Claims the next due reply turn for this instance of the Actor and counts
 * the attempt. One instance runs at a time, so a claim another instance
 * holds belongs to an attempt that stopped with it and is taken over now. A
 * turn this instance is still running is never claimed twice, and a turn
 * that has used every attempt is dropped.
 */
export function claimDueEmailReplyTurn(
  sql: SqlStorage,
  input: Readonly<{
    now: number;
    owner: string;
    running: ReadonlySet<string>;
  }>,
): EmailReplyTurnWork | null {
  sql.exec(
    `UPDATE connector_email_reply_turn
     SET claimed_by = NULL, available_at = MIN(available_at, ?)
     WHERE claimed_by IS NOT NULL AND claimed_by <> ?`,
    input.now,
    input.owner,
  );
  const rows = sql
    .exec<{
      provider_message_id: string;
      case_id: string;
      thread_id: string;
      message_ids_json: string;
      attempts: number;
      disposition: string | null;
    }>(
      `SELECT provider_message_id, case_id, thread_id, message_ids_json,
              attempts, disposition
       FROM connector_email_reply_turn
       WHERE available_at <= ?
       ORDER BY available_at, provider_message_id`,
      input.now,
    )
    .toArray();
  for (const row of rows) {
    if (input.running.has(row.provider_message_id)) {
      // Still running here past its lease. The lease is renewed, so the
      // Actor does not wake again and again for a turn it cannot claim.
      sql.exec(
        "UPDATE connector_email_reply_turn SET available_at = ? WHERE provider_message_id = ?",
        input.now + EMAIL_REPLY_TURN_LEASE_MS,
        row.provider_message_id,
      );
      continue;
    }
    const messageIds = parseCaseContextDiscoveryMessageIds(
      row.message_ids_json,
      row.provider_message_id,
    );
    if (messageIds === null || row.attempts >= EMAIL_REPLY_TURN_MAX_ATTEMPTS) {
      completeEmailReplyTurn(sql, row.provider_message_id);
      continue;
    }
    sql.exec(
      `UPDATE connector_email_reply_turn
       SET attempts = attempts + 1, claimed_by = ?, available_at = ?
       WHERE provider_message_id = ?`,
      input.owner,
      input.now + EMAIL_REPLY_TURN_LEASE_MS,
      row.provider_message_id,
    );
    return {
      providerMessageId: row.provider_message_id,
      caseId: row.case_id,
      threadId: row.thread_id,
      messageIds,
      attempt: row.attempts + 1,
      disposition:
        row.disposition === "reply_now" ||
        row.disposition === "approval_required"
          ? row.disposition
          : null,
    };
  }
  return null;
}

export function completeEmailReplyTurn(
  sql: SqlStorage,
  providerMessageId: string,
): void {
  sql.exec(
    "DELETE FROM connector_email_reply_turn WHERE provider_message_id = ?",
    providerMessageId,
  );
}

/** Schedules another attempt, or drops the turn once its attempts are spent. */
export function retryEmailReplyTurn(
  sql: SqlStorage,
  input: Readonly<{ work: EmailReplyTurnWork; now: number }>,
): "scheduled" | "exhausted" {
  const delay =
    EMAIL_CASE_CONTEXT_DISCOVERY_RETRY_DELAYS_MS[input.work.attempt - 1];
  if (delay === undefined) {
    completeEmailReplyTurn(sql, input.work.providerMessageId);
    return "exhausted";
  }
  sql.exec(
    `UPDATE connector_email_reply_turn
     SET claimed_by = NULL, available_at = ?
     WHERE provider_message_id = ?`,
    input.now + delay,
    input.work.providerMessageId,
  );
  return "scheduled";
}

/**
 * Keeps what a reply turn chose, before its draft is created. An attempt
 * that takes over a draft an earlier one created finishes that choice.
 */
export function recordEmailReplyTurnDisposition(
  sql: SqlStorage,
  providerMessageId: string,
  disposition: EmailReplyDisposition,
): void {
  sql.exec(
    "UPDATE connector_email_reply_turn SET disposition = ? WHERE provider_message_id = ?",
    disposition,
    providerMessageId,
  );
}

export function readEmailReplyCorrection(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): EmailReplyCorrection | null {
  const row = sql
    .exec<{
      case_id: string;
      corrected_version: number;
      corrected_body_digest: string;
      body_digest: string;
      editor_person_id: string;
      flow_binding_json: string;
      recorded_at: number;
    }>(
      "SELECT * FROM connector_email_reply_correction WHERE proposal_id = ? AND version = ?",
      proposalId,
      version,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    proposalId,
    version,
    caseId: row.case_id,
    correctedVersion: row.corrected_version,
    correctedBodyDigest: row.corrected_body_digest,
    bodyDigest: row.body_digest,
    editorPersonId: row.editor_person_id,
    flowBindingJson: row.flow_binding_json,
    recordedAt: row.recorded_at,
  };
}

export function readEmailDraftOperation(
  sql: SqlStorage,
  proposalId: string,
  version: number,
): EmailDraftOperation | null {
  const row = sql
    .exec<{
      proposal_id: string;
      version: number;
      case_id: string;
      thread_id: string;
      draft_id: string;
      draft_message_id: string;
      triggering_message_id: string;
      target_digest: string;
      body_digest: string;
      snapshot_digest: string;
      policy_version: number;
      state: string;
      approved_snapshot_digest: string | null;
      sent_message_id: string | null;
      created_at: number;
      expires_at: number;
    }>(
      "SELECT * FROM connector_email_draft WHERE proposal_id = ? AND version = ?",
      proposalId,
      version,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    proposalId: row.proposal_id,
    version: row.version,
    caseId: row.case_id,
    threadId: row.thread_id,
    draftId: row.draft_id,
    draftMessageId: row.draft_message_id,
    triggeringMessageId: row.triggering_message_id,
    targetDigest: row.target_digest,
    bodyDigest: row.body_digest,
    snapshotDigest: row.snapshot_digest,
    policyVersion: row.policy_version,
    state: decodeEmailDraftState(row.state),
    approvedSnapshotDigest: row.approved_snapshot_digest,
    sentMessageId: row.sent_message_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function latestEmailDraftOperation(
  sql: SqlStorage,
  proposalId: string,
): EmailDraftOperation | null {
  const row = sql
    .exec<{ version: number }>(
      "SELECT MAX(version) AS version FROM connector_email_draft WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (row === undefined || row.version === null) return null;
  return readEmailDraftOperation(sql, proposalId, row.version);
}

/**
 * Every proposal whose newest version still owns a Gmail draft. Revocation and
 * teardown walk this set so no Pantry-created draft is left behind in an organisation
 * mailbox. Sent and deleted rows are excluded because their draft is already
 * gone; cleanup states stay in the set so a later attempt can retry them.
 */
export function pendingEmailDraftProposals(
  sql: SqlStorage,
): readonly EmailDraftOperation[] {
  const rows = sql
    .exec<{ proposal_id: string; version: number }>(
      `SELECT draft.proposal_id AS proposal_id, draft.version AS version
       FROM connector_email_draft AS draft
       JOIN (
         SELECT proposal_id, MAX(version) AS version
           FROM connector_email_draft
          GROUP BY proposal_id
       ) AS latest
         ON latest.proposal_id = draft.proposal_id AND latest.version = draft.version
      ORDER BY draft.proposal_id`,
    )
    .toArray();
  const pending: EmailDraftOperation[] = [];
  for (const row of rows) {
    const operation = readEmailDraftOperation(
      sql,
      row.proposal_id,
      row.version,
    );
    if (operation === null) continue;
    switch (operation.state) {
      case "awaiting_approval":
      case "send_indeterminate":
      case "invalidated":
      case "cleanup_pending":
      case "cleanup_unreachable":
        pending.push(operation);
        break;
      case "sent":
      case "deleted":
        break;
      default:
        assertNever(operation.state);
    }
  }
  return pending;
}

export const EMAIL_RESOLVE_GRACE_MS = 5 * 60_000;
export const EMAIL_MAINTENANCE_INTERVAL_MS = 3_600_000;

export function requestEmailWatchCleanup(sql: SqlStorage, now: number): void {
  sql.exec(
    "INSERT INTO connector_email_watch_cleanup (singleton, available_at) VALUES (1, ?) ON CONFLICT (singleton) DO NOTHING",
    now,
  );
}

export function nextEmailWatchCleanupAt(sql: SqlStorage): number | null {
  return (
    sql
      .exec<{ available_at: number }>(
        "SELECT available_at FROM connector_email_watch_cleanup WHERE singleton = 1",
      )
      .toArray()[0]?.available_at ?? null
  );
}

export function deferEmailWatchCleanup(sql: SqlStorage, now: number): void {
  sql.exec(
    "UPDATE connector_email_watch_cleanup SET available_at = ? WHERE singleton = 1",
    now + EMAIL_MAINTENANCE_INTERVAL_MS,
  );
}

export function settleEmailWatchCleanup(sql: SqlStorage): void {
  sql.exec("DELETE FROM connector_email_watch_cleanup WHERE singleton = 1");
  sql.exec(
    "UPDATE connector_email_runtime SET watch_expires_at = NULL WHERE singleton = 1",
  );
}

type EmailMaintenanceCandidate = {
  readonly operation: EmailDraftOperation;
  readonly action: "dispose_expired" | "resolve";
};

/**
 * Proposal-lifecycle states that cannot wait for a human. An expired proposal
 * still owns a visible draft in the organisation's Gmail; an indeterminate send may
 * already be in the customer's inbox while the console shows it unconfirmed;
 * a pending cleanup is a delete that failed transiently. Each has a defined
 * recovery that needs no judgement, so the Connector performs it on a clock
 * instead of leaving it to whoever happens to open the preview next.
 */
export function emailMaintenanceCandidates(
  sql: SqlStorage,
  now: number,
): readonly EmailMaintenanceCandidate[] {
  const candidates: EmailMaintenanceCandidate[] = [];
  for (const operation of pendingEmailDraftProposals(sql)) {
    if (
      operation.state === "awaiting_approval" ||
      operation.state === "invalidated"
    ) {
      if (now > operation.expiresAt) {
        candidates.push({ operation, action: "dispose_expired" });
      }
      continue;
    }
    // send_indeterminate, cleanup_pending, cleanup_unreachable: recover after
    // a short grace so an operator action still in flight is never raced.
    if (now >= updatedAtOf(sql, operation) + EMAIL_RESOLVE_GRACE_MS) {
      candidates.push({ operation, action: "resolve" });
    }
  }
  return candidates;
}

function updatedAtOf(sql: SqlStorage, operation: EmailDraftOperation): number {
  const row = sql
    .exec<{ updated_at: number }>(
      "SELECT updated_at FROM connector_email_draft WHERE proposal_id = ? AND version = ?",
      operation.proposalId,
      operation.version,
    )
    .toArray()[0];
  return row?.updated_at ?? 0;
}

/**
 * When the next maintenance pass is due, or null when nothing needs one. A
 * candidate whose natural time has passed is floored to one interval after the
 * last pass, so an item that cannot make progress — an unreachable credential,
 * a Gmail outage — retries hourly instead of hot-looping the alarm.
 */
export function nextEmailMaintenanceAt(
  sql: SqlStorage,
  now: number,
): number | null {
  const times: number[] = [];
  const caseContextCollectionCleanup =
    nextEmailCaseContextCollectionDraftCleanupAt(sql);
  if (caseContextCollectionCleanup !== null)
    times.push(caseContextCollectionCleanup);
  for (const operation of pendingEmailDraftProposals(sql)) {
    if (
      operation.state === "awaiting_approval" ||
      operation.state === "invalidated"
    ) {
      times.push(operation.expiresAt);
    } else {
      times.push(updatedAtOf(sql, operation) + EMAIL_RESOLVE_GRACE_MS);
    }
  }
  if (times.length === 0) return null;
  const earliest = Math.min(...times);
  if (earliest > now) return earliest;
  const lastPass =
    sql
      .exec<{ last_pass_at: number }>(
        "SELECT last_pass_at FROM connector_email_maintenance WHERE singleton = 1",
      )
      .toArray()[0]?.last_pass_at ?? 0;
  return Math.max(earliest, lastPass + EMAIL_MAINTENANCE_INTERVAL_MS);
}

/**
 * Claims one maintenance pass. Returns false when the pass is not yet due, so
 * an alarm that fired for evaluation or Case work does not also sweep.
 */
export function claimEmailMaintenancePass(
  sql: SqlStorage,
  now: number,
): boolean {
  const due = nextEmailMaintenanceAt(sql, now);
  if (due === null || due > now) return false;
  const existing = sql
    .exec<{ last_pass_at: number }>(
      "SELECT last_pass_at FROM connector_email_maintenance WHERE singleton = 1",
    )
    .toArray()[0];
  if (existing === undefined) {
    sql.exec(
      "INSERT INTO connector_email_maintenance (singleton, last_pass_at) VALUES (1, ?)",
      now,
    );
  } else {
    sql.exec(
      "UPDATE connector_email_maintenance SET last_pass_at = ? WHERE singleton = 1",
      now,
    );
  }
  return true;
}

export function updateEmailDraftState(
  sql: SqlStorage,
  input: Readonly<{
    proposalId: string;
    version: number;
    state: EmailDraftState;
    approvedSnapshotDigest?: string | null;
    sentMessageId?: string | null;
    bodyDigest?: string;
    snapshotDigest?: string;
    now: number;
  }>,
): void {
  const current = readEmailDraftOperation(sql, input.proposalId, input.version);
  if (current === null) return;
  sql.exec(
    `UPDATE connector_email_draft
       SET state = ?, approved_snapshot_digest = ?, sent_message_id = ?,
           body_digest = ?, snapshot_digest = ?, updated_at = ?
       WHERE proposal_id = ? AND version = ?`,
    input.state,
    input.approvedSnapshotDigest === undefined
      ? current.approvedSnapshotDigest
      : input.approvedSnapshotDigest,
    input.sentMessageId === undefined
      ? current.sentMessageId
      : input.sentMessageId,
    input.bodyDigest ?? current.bodyDigest,
    input.snapshotDigest ?? current.snapshotDigest,
    input.now,
    input.proposalId,
    input.version,
  );
}

export function activateEmailRuntime(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    policyVersion: number;
    limits: EmailIngressLimits;
    activationFloor: string;
    watchExpiresAt: number;
    now: number;
  }>,
): Result<EmailRuntimeSnapshot, EmailRuntimeError> {
  const existing = readEmailRuntime(sql);
  if (
    existing !== null &&
    existing.integrationAccountId !== input.integrationAccountId
  ) {
    return { ok: false, error: { code: "connector_email_identity_conflict" } };
  }
  if (
    existing !== null &&
    existing.disabledAt === null &&
    existing.policyVersion === input.policyVersion
  ) {
    return { ok: true, value: existing };
  }
  const processing: EmailProcessingState = { kind: "scheduled", at: input.now };
  sql.exec(
    `INSERT INTO connector_email_runtime (
       singleton, organisation_id, integration_account_id, policy_version, limits_json,
       activation_floor, accepted_history_id, highest_observed_history_id,
       watch_expires_at, processing_json, last_evaluation_started_at, disabled_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT (singleton) DO UPDATE SET
       policy_version = excluded.policy_version,
       limits_json = excluded.limits_json,
       activation_floor = excluded.activation_floor,
       accepted_history_id = excluded.accepted_history_id,
       highest_observed_history_id = excluded.highest_observed_history_id,
       watch_expires_at = excluded.watch_expires_at,
       processing_json = excluded.processing_json,
       last_evaluation_started_at = NULL,
       disabled_at = NULL`,
    input.organisationId,
    input.integrationAccountId,
    input.policyVersion,
    JSON.stringify(input.limits),
    input.activationFloor,
    input.activationFloor,
    input.activationFloor,
    input.watchExpiresAt,
    JSON.stringify(processing),
  );
  const stored = readEmailRuntime(sql);
  return stored === null
    ? { ok: false, error: { code: "connector_email_runtime_missing" } }
    : { ok: true, value: stored };
}

/**
 * Live limit changes on an active runtime keep the activation floor and
 * accepted cursor: only a disable followed by re-enable establishes a new
 * floor. The processing state is preserved, so a paused mailbox stays
 * paused until an explicit resume.
 */
export function updateEmailRuntimePolicy(
  sql: SqlStorage,
  input: Readonly<{
    policyVersion: number;
    limits: EmailIngressLimits;
  }>,
): Result<EmailRuntimeSnapshot, EmailRuntimeError> {
  const runtime = readEmailRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null) {
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  }
  sql.exec(
    "UPDATE connector_email_runtime SET policy_version = ?, limits_json = ? WHERE singleton = 1",
    input.policyVersion,
    JSON.stringify(input.limits),
  );
  const updated = readEmailRuntime(sql);
  return updated === null
    ? { ok: false, error: { code: "connector_email_runtime_missing" } }
    : { ok: true, value: updated };
}

/**
 * Restores processing after a credential reconnection without moving the
 * Gmail history cursor. Mail that arrived while authorization was broken is
 * still behind the accepted cursor, so keeping it is what lets the next
 * evaluation catch up instead of skipping the outage. Only a cursor Gmail can
 * no longer serve justifies a fresh floor, and that path goes through
 * activation instead.
 */
export function reconnectEmailRuntime(
  sql: SqlStorage,
  input: Readonly<{
    policyVersion: number;
    limits: EmailIngressLimits;
    watchExpiresAt: number;
    now: number;
  }>,
): Result<EmailRuntimeSnapshot, EmailRuntimeError> {
  const runtime = readEmailRuntime(sql);
  if (runtime === null)
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  const processing: EmailProcessingState = { kind: "scheduled", at: input.now };
  sql.exec(
    `UPDATE connector_email_runtime
       SET policy_version = ?, limits_json = ?, watch_expires_at = ?,
           processing_json = ?, disabled_at = NULL
       WHERE singleton = 1`,
    input.policyVersion,
    JSON.stringify(input.limits),
    input.watchExpiresAt,
    JSON.stringify(processing),
  );
  const updated = readEmailRuntime(sql);
  return updated === null
    ? { ok: false, error: { code: "connector_email_runtime_missing" } }
    : { ok: true, value: updated };
}

export function disableEmailRuntime(
  sql: SqlStorage,
  input: Readonly<{ now: number }>,
): Result<null, EmailRuntimeError> {
  const runtime = readEmailRuntime(sql);
  if (runtime === null) return { ok: true, value: null };
  sql.exec(
    `UPDATE connector_email_runtime
       SET disabled_at = ?, processing_json = ?
       WHERE singleton = 1`,
    input.now,
    JSON.stringify({ kind: "waiting" } satisfies EmailProcessingState),
  );
  // A disabled mailbox answers nothing, so no queued reply turn outlives it.
  sql.exec("DELETE FROM connector_email_reply_turn");
  return { ok: true, value: null };
}

export type EmailHintAcceptance =
  | { readonly kind: "scheduled"; readonly at: number }
  | { readonly kind: "observed" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "inactive" };

export function acceptEmailHint(
  sql: SqlStorage,
  input: Readonly<{
    notificationId: string;
    historyId: string;
    now: number;
  }>,
): EmailHintAcceptance {
  const runtime = readEmailRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null)
    return { kind: "inactive" };
  const duplicate = sql
    .exec<{ notification_id: string }>(
      "SELECT notification_id FROM connector_email_notification WHERE notification_id = ?",
      input.notificationId,
    )
    .toArray()[0];
  if (duplicate !== undefined) return { kind: "duplicate" };
  sql.exec(
    "INSERT INTO connector_email_notification (notification_id, observed_at) VALUES (?, ?)",
    input.notificationId,
    input.now,
  );
  if (
    compareGmailHistoryIds(input.historyId, runtime.highestObservedHistoryId) >
    0
  ) {
    sql.exec(
      "UPDATE connector_email_runtime SET highest_observed_history_id = ? WHERE singleton = 1",
      input.historyId,
    );
  }
  if (
    runtime.processing.kind === "paused" ||
    runtime.processing.kind === "evaluating"
  ) {
    return { kind: "observed" };
  }
  if (runtime.processing.kind === "scheduled") {
    return { kind: "scheduled", at: runtime.processing.at };
  }
  const at = Math.max(
    input.now + EMAIL_EVALUATION_INTERVAL_MS,
    (runtime.lastEvaluationStartedAt ?? 0) + EMAIL_EVALUATION_INTERVAL_MS,
  );
  writeProcessing(sql, { kind: "scheduled", at });
  return { kind: "scheduled", at };
}

export function nextEmailEvaluationAt(sql: SqlStorage): number | null {
  const runtime = readEmailRuntime(sql);
  return runtime !== null &&
    runtime.disabledAt === null &&
    runtime.processing.kind === "scheduled"
    ? runtime.processing.at
    : null;
}

type EmailEvaluationClaim =
  | { readonly kind: "idle" }
  | { readonly kind: "due"; readonly runtime: EmailRuntimeSnapshot };

export function claimDueEmailEvaluation(
  sql: SqlStorage,
  now: number,
): EmailEvaluationClaim {
  const runtime = readEmailRuntime(sql);
  if (
    runtime === null ||
    runtime.disabledAt !== null ||
    runtime.processing.kind !== "scheduled" ||
    runtime.processing.at > now
  ) {
    return { kind: "idle" };
  }
  sql.exec(
    `UPDATE connector_email_runtime
       SET processing_json = ?, last_evaluation_started_at = ?
       WHERE singleton = 1`,
    JSON.stringify({
      kind: "evaluating",
      startedAt: now,
    } satisfies EmailProcessingState),
    now,
  );
  const claimed = readEmailRuntime(sql);
  return claimed === null
    ? { kind: "idle" }
    : { kind: "due", runtime: claimed };
}

export type EmailAdmission = {
  readonly providerMessageId: string;
  readonly threadId: string;
  readonly caseId: string;
};

export function recordEmailAdmissions(
  sql: SqlStorage,
  input: Readonly<{
    admitted: readonly EmailAdmission[];
    policyVersion: number;
    now: number;
  }>,
): void {
  for (const admission of input.admitted) {
    sql.exec(
      `INSERT INTO connector_email_message (
         provider_message_id, thread_id, case_id, disposition, policy_version, admitted_at
       ) VALUES (?, ?, ?, 'admitted', ?, ?)
       ON CONFLICT (provider_message_id) DO NOTHING`,
      admission.providerMessageId,
      admission.threadId,
      admission.caseId,
      input.policyVersion,
      input.now,
    );
    sql.exec(
      `INSERT INTO connector_email_case (case_id, thread_id, opened_at, closed_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT (case_id) DO NOTHING`,
      admission.caseId,
      admission.threadId,
      input.now,
    );
  }
}

export function recordEmailCaseContextDiscovery(
  sql: SqlStorage,
  input: Readonly<{
    organisationId: string;
    integrationAccountId: string;
    caseId: string;
    threadId: string;
    messageIds: readonly string[];
    policyVersion: number;
    now: number;
  }>,
): void {
  const providerMessageId = input.messageIds.at(-1);
  if (providerMessageId === undefined) return;
  sql.exec(
    `INSERT INTO connector_email_case_context_discovery (
       integration_account_id, provider_message_id, organisation_id, case_id,
       thread_id, message_ids_json, policy_version, admitted_at, attempts,
       available_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (integration_account_id, provider_message_id) DO NOTHING`,
    input.integrationAccountId,
    providerMessageId,
    input.organisationId,
    input.caseId,
    input.threadId,
    JSON.stringify(input.messageIds),
    input.policyVersion,
    input.now,
    input.now,
  );
}

export function nextEmailCaseContextDiscoveryAt(
  sql: SqlStorage,
): number | null {
  const row = sql
    .exec<{ available_at: number | null }>(
      `SELECT MIN(available_at) AS available_at
       FROM connector_email_case_context_discovery`,
    )
    .toArray()[0];
  return row?.available_at ?? null;
}

export function dueEmailCaseContextDiscovery(
  sql: SqlStorage,
  now: number,
): EmailCaseContextDiscoveryWork | null {
  const row = sql
    .exec<{
      organisation_id: string;
      integration_account_id: string;
      provider_message_id: string;
      case_id: string;
      thread_id: string;
      message_ids_json: string;
      policy_version: number;
      admitted_at: number;
      attempts: number;
      available_at: number;
    }>(
      `SELECT organisation_id, integration_account_id, provider_message_id, case_id,
              thread_id, message_ids_json, policy_version, admitted_at,
              attempts, available_at
       FROM connector_email_case_context_discovery
       WHERE available_at <= ?
       ORDER BY available_at, integration_account_id, provider_message_id
       LIMIT 1`,
      now,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const messageIds = parseCaseContextDiscoveryMessageIds(
    row.message_ids_json,
    row.provider_message_id,
  );
  if (messageIds === null) {
    completeEmailCaseContextDiscovery(sql, {
      integrationAccountId: row.integration_account_id,
      providerMessageId: row.provider_message_id,
    });
    return null;
  }
  return {
    organisationId: row.organisation_id,
    integrationAccountId: row.integration_account_id,
    providerMessageId: row.provider_message_id,
    caseId: row.case_id,
    threadId: row.thread_id,
    messageIds,
    policyVersion: row.policy_version,
    admittedAt: row.admitted_at,
    attempts: row.attempts,
    availableAt: row.available_at,
  };
}

export function completeEmailCaseContextDiscovery(
  sql: SqlStorage,
  input: Pick<
    EmailCaseContextDiscoveryWork,
    "integrationAccountId" | "providerMessageId"
  >,
): void {
  sql.exec(
    `DELETE FROM connector_email_case_context_discovery
     WHERE integration_account_id = ? AND provider_message_id = ?`,
    input.integrationAccountId,
    input.providerMessageId,
  );
}

export function retryEmailCaseContextDiscovery(
  sql: SqlStorage,
  input: Readonly<{
    work: EmailCaseContextDiscoveryWork;
    now: number;
  }>,
): "scheduled" | "exhausted" {
  const nextAttempt = input.work.attempts + 1;
  const delay =
    EMAIL_CASE_CONTEXT_DISCOVERY_RETRY_DELAYS_MS[input.work.attempts];
  if (delay === undefined) {
    completeEmailCaseContextDiscovery(sql, input.work);
    return "exhausted";
  }
  sql.exec(
    `UPDATE connector_email_case_context_discovery
     SET attempts = ?, available_at = ?
     WHERE integration_account_id = ? AND provider_message_id = ?`,
    nextAttempt,
    input.now + delay,
    input.work.integrationAccountId,
    input.work.providerMessageId,
  );
  return "scheduled";
}

function parseCaseContextDiscoveryMessageIds(
  raw: string,
  providerMessageId: string,
): readonly string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some(
        (messageId) => typeof messageId !== "string" || messageId.length === 0,
      ) ||
      value.at(-1) !== providerMessageId
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function completeEmailEvaluation(
  sql: SqlStorage,
  input: Readonly<{
    acceptedHistoryId: string;
    now: number;
  }>,
): void {
  const runtime = readEmailRuntime(sql);
  if (runtime === null || runtime.processing.kind !== "evaluating") return;
  const advanced =
    compareGmailHistoryIds(input.acceptedHistoryId, runtime.acceptedHistoryId) >
    0
      ? input.acceptedHistoryId
      : runtime.acceptedHistoryId;
  const backlog =
    compareGmailHistoryIds(runtime.highestObservedHistoryId, advanced) > 0;
  const processing: EmailProcessingState = backlog
    ? {
        kind: "scheduled",
        at: runtime.processing.startedAt + EMAIL_EVALUATION_INTERVAL_MS,
      }
    : { kind: "waiting" };
  sql.exec(
    `UPDATE connector_email_runtime
       SET accepted_history_id = ?, processing_json = ?
       WHERE singleton = 1`,
    advanced,
    JSON.stringify(processing),
  );
}

export function pauseEmailRuntime(
  sql: SqlStorage,
  input: Readonly<{
    reason: MailboxProcessingPauseReason;
    now: number;
  }>,
): Result<{ readonly firstPause: boolean }, EmailRuntimeError> {
  const runtime = readEmailRuntime(sql);
  if (runtime === null)
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  writeProcessing(sql, {
    kind: "paused",
    reason: input.reason,
    pausedAt: input.now,
    policyVersion: runtime.policyVersion,
  });
  const receiptKey = `pause_${runtime.policyVersion}_${input.reason.kind}_${runtime.acceptedHistoryId}`;
  const existing = sql
    .exec<{ receipt_key: string }>(
      "SELECT receipt_key FROM connector_email_pause_receipt WHERE receipt_key = ?",
      receiptKey,
    )
    .toArray()[0];
  if (existing !== undefined) return { ok: true, value: { firstPause: false } };
  sql.exec(
    `INSERT INTO connector_email_pause_receipt (
       receipt_key, reason_json, policy_version, accepted_history_id, paused_at
     ) VALUES (?, ?, ?, ?, ?)`,
    receiptKey,
    JSON.stringify(input.reason),
    runtime.policyVersion,
    runtime.acceptedHistoryId,
    input.now,
  );
  return { ok: true, value: { firstPause: true } };
}

export function resumeEmailRuntime(
  sql: SqlStorage,
  input: Readonly<{
    policyVersion: number;
    limits: EmailIngressLimits;
    skipProviderMessageId: string | null;
    now: number;
  }>,
): Result<EmailRuntimeSnapshot, EmailRuntimeError> {
  const runtime = readEmailRuntime(sql);
  if (runtime === null || runtime.disabledAt !== null) {
    return { ok: false, error: { code: "connector_email_runtime_missing" } };
  }
  if (runtime.processing.kind !== "paused") {
    return { ok: false, error: { code: "connector_email_not_paused" } };
  }
  if (input.skipProviderMessageId !== null) {
    const reason = runtime.processing.reason;
    const oversized =
      reason.kind === "message_too_large" ||
      reason.kind === "attachment_too_large" ||
      reason.kind === "attachment_total_too_large";
    if (
      !oversized ||
      reason.providerMessageId !== input.skipProviderMessageId
    ) {
      return {
        ok: false,
        error: { code: "connector_email_skip_target_invalid" },
      };
    }
    sql.exec(
      `INSERT INTO connector_email_message (
         provider_message_id, thread_id, case_id, disposition, policy_version, admitted_at
       ) VALUES (?, '', '', 'skipped', ?, ?)
       ON CONFLICT (provider_message_id) DO NOTHING`,
      input.skipProviderMessageId,
      input.policyVersion,
      input.now,
    );
  }
  sql.exec(
    `UPDATE connector_email_runtime
       SET policy_version = ?, limits_json = ?, processing_json = ?
       WHERE singleton = 1`,
    input.policyVersion,
    JSON.stringify(input.limits),
    JSON.stringify({
      kind: "scheduled",
      at: input.now,
    } satisfies EmailProcessingState),
  );
  const resumed = readEmailRuntime(sql);
  return resumed === null
    ? { ok: false, error: { code: "connector_email_runtime_missing" } }
    : { ok: true, value: resumed };
}

export function emailMessageDisposition(
  sql: SqlStorage,
  providerMessageId: string,
): "admitted" | "skipped" | null {
  const row = sql
    .exec<{ disposition: string }>(
      "SELECT disposition FROM connector_email_message WHERE provider_message_id = ?",
      providerMessageId,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : row.disposition === "skipped"
      ? "skipped"
      : "admitted";
}

export function countEmailAdmissionsSince(
  sql: SqlStorage,
  since: number,
): number {
  const row = sql
    .exec<{ total: number }>(
      `SELECT COUNT(*) AS total FROM connector_email_message
       WHERE disposition = 'admitted' AND admitted_at >= ?`,
      since,
    )
    .toArray()[0];
  return row?.total ?? 0;
}

/**
 * The emails in progress: the threads whose reply turn is queued or running.
 * The turn is queued with the mail's admission and leaves the queue when its
 * work ends: a reply sent, a draft saved, no reply, a refusal, or the last
 * failed attempt. So a thread holds a place under `maxActiveCases` only
 * while the agent works on it.
 */
export function countEmailThreadsInProgress(sql: SqlStorage): number {
  const row = sql
    .exec<{ total: number }>(
      "SELECT COUNT(DISTINCT thread_id) AS total FROM connector_email_reply_turn",
    )
    .toArray()[0];
  return row?.total ?? 0;
}

/** Whether a reply turn of this thread is queued or running. */
export function emailThreadInProgress(
  sql: SqlStorage,
  threadId: string,
): boolean {
  return (
    sql
      .exec(
        "SELECT 1 FROM connector_email_reply_turn WHERE thread_id = ? LIMIT 1",
        threadId,
      )
      .toArray().length > 0
  );
}

/** The Case of a thread that the mailbox admitted before, or null. */
export function emailCaseForThread(
  sql: SqlStorage,
  threadId: string,
): string | null {
  const row = sql
    .exec<{ case_id: string }>(
      "SELECT case_id FROM connector_email_case WHERE thread_id = ?",
      threadId,
    )
    .toArray()[0];
  return row?.case_id ?? null;
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcDayEndsAt(now: number): number {
  const dayStart = Date.parse(`${utcDayKey(now)}T00:00:00.000Z`);
  return dayStart + 86_400_000;
}

type EmailTokenWindow = {
  readonly reserved: number;
  readonly consumed: number;
};

export function emailTokenWindowTotals(
  sql: SqlStorage,
  utcDay: string,
): EmailTokenWindow {
  const row = sql
    .exec<{ reserved: number | null; consumed: number | null }>(
      `SELECT
       SUM(CASE WHEN state = 'reserved' THEN tokens ELSE 0 END) AS reserved,
       SUM(CASE WHEN state = 'settled' THEN settled_tokens ELSE 0 END) AS consumed
     FROM connector_email_reservation WHERE utc_day = ?`,
      utcDay,
    )
    .toArray()[0];
  return { reserved: row?.reserved ?? 0, consumed: row?.consumed ?? 0 };
}

type EmailTokenReservation =
  | { readonly kind: "reserved"; readonly reservationId: string }
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "exhausted";
      readonly reserved: number;
      readonly consumed: number;
      readonly limit: number;
    };

export function reserveEmailTokens(
  sql: SqlStorage,
  input: Readonly<{
    reservationId: string;
    utcDay: string;
    tokens: number;
    limit: number;
    now: number;
  }>,
): EmailTokenReservation {
  const existing = sql
    .exec<{ reservation_id: string }>(
      "SELECT reservation_id FROM connector_email_reservation WHERE reservation_id = ?",
      input.reservationId,
    )
    .toArray()[0];
  if (existing !== undefined) return { kind: "duplicate" };
  const window = emailTokenWindowTotals(sql, input.utcDay);
  if (window.reserved + window.consumed + input.tokens > input.limit) {
    return {
      kind: "exhausted",
      reserved: window.reserved,
      consumed: window.consumed,
      limit: input.limit,
    };
  }
  sql.exec(
    `INSERT INTO connector_email_reservation (
       reservation_id, utc_day, tokens, state, settled_tokens, created_at
     ) VALUES (?, ?, ?, 'reserved', NULL, ?)`,
    input.reservationId,
    input.utcDay,
    input.tokens,
    input.now,
  );
  return { kind: "reserved", reservationId: input.reservationId };
}

export function settleEmailReservation(
  sql: SqlStorage,
  input: Readonly<{
    reservationId: string;
    actualTokens: number;
  }>,
): boolean {
  if (!reservationIsReserved(sql, input.reservationId)) return false;
  sql.exec(
    `UPDATE connector_email_reservation
       SET state = 'settled', settled_tokens = ?
       WHERE reservation_id = ? AND state = 'reserved'`,
    Math.max(0, input.actualTokens),
    input.reservationId,
  );
  return true;
}

/**
 * The share of its reservation that an attempt is charged when it stopped
 * after its assignment began and its usage was never reported: one part in
 * this many.
 */
const ABANDONED_EMAIL_ATTEMPT_CHARGE_DIVISOR = 4;

/**
 * Settles the reservation of an attempt that stopped after its assignment
 * began work. The model may have been asked, and its usage was never
 * reported. The attempt is charged a quarter of its reservation, rounded up.
 * That is an estimate of a turn that ran in part: the reservation is the most
 * a whole turn may use, and a charge of all of it left a small daily budget
 * with nothing for the attempt that takes the turn over.
 */
export function settleAbandonedEmailReservation(
  sql: SqlStorage,
  reservationId: string,
): void {
  // A bound number is a real, so the quotient is cut to whole tokens.
  sql.exec(
    `UPDATE connector_email_reservation
       SET state = 'settled',
           settled_tokens = CAST((tokens + ?) / ? AS INTEGER)
       WHERE reservation_id = ? AND state = 'reserved'`,
    ABANDONED_EMAIL_ATTEMPT_CHARGE_DIVISOR - 1,
    ABANDONED_EMAIL_ATTEMPT_CHARGE_DIVISOR,
    reservationId,
  );
}

export function releaseEmailReservation(
  sql: SqlStorage,
  reservationId: string,
): boolean {
  if (!reservationIsReserved(sql, reservationId)) return false;
  sql.exec(
    `UPDATE connector_email_reservation
       SET state = 'released'
       WHERE reservation_id = ? AND state = 'reserved'`,
    reservationId,
  );
  return true;
}

function reservationIsReserved(
  sql: SqlStorage,
  reservationId: string,
): boolean {
  const row = sql
    .exec<{ reservation_id: string }>(
      "SELECT reservation_id FROM connector_email_reservation WHERE reservation_id = ? AND state = 'reserved'",
      reservationId,
    )
    .toArray()[0];
  return row !== undefined;
}

export function markEmailWatch(sql: SqlStorage, expiresAt: number): void {
  sql.exec(
    "UPDATE connector_email_runtime SET watch_expires_at = ? WHERE singleton = 1",
    expiresAt,
  );
}

export function readEmailRuntime(sql: SqlStorage): EmailRuntimeSnapshot | null {
  const row = sql
    .exec<{
      organisation_id: string;
      integration_account_id: string;
      policy_version: number;
      limits_json: string;
      activation_floor: string;
      accepted_history_id: string;
      highest_observed_history_id: string;
      watch_expires_at: number | null;
      processing_json: string;
      last_evaluation_started_at: number | null;
      disabled_at: number | null;
    }>("SELECT * FROM connector_email_runtime WHERE singleton = 1")
    .toArray()[0];
  if (row === undefined) return null;
  const limits = parseLimits(row.limits_json);
  const processing = parseProcessing(row.processing_json);
  if (limits === null || processing === null) return null;
  return {
    organisationId: row.organisation_id,
    integrationAccountId: row.integration_account_id,
    policyVersion: row.policy_version,
    limits,
    activationFloor: row.activation_floor,
    acceptedHistoryId: row.accepted_history_id,
    highestObservedHistoryId: row.highest_observed_history_id,
    watchExpiresAt: row.watch_expires_at,
    processing,
    lastEvaluationStartedAt: row.last_evaluation_started_at,
    disabledAt: row.disabled_at,
  };
}

function writeProcessing(
  sql: SqlStorage,
  processing: EmailProcessingState,
): void {
  sql.exec(
    "UPDATE connector_email_runtime SET processing_json = ? WHERE singleton = 1",
    JSON.stringify(processing),
  );
}

function parseLimits(raw: string): EmailIngressLimits | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const limits = value as Record<string, unknown>;
    return typeof limits.maxActiveCases === "number" &&
      typeof limits.maxMessagesPerHour === "number" &&
      typeof limits.dailyTokenBudget === "number" &&
      typeof limits.maxMessageBytes === "number" &&
      typeof limits.maxAttachmentBytes === "number"
      ? {
          maxActiveCases: limits.maxActiveCases,
          maxMessagesPerHour: limits.maxMessagesPerHour,
          dailyTokenBudget: limits.dailyTokenBudget,
          maxMessageBytes: limits.maxMessageBytes,
          maxAttachmentBytes: limits.maxAttachmentBytes,
          debounce: { kind: "push_triggered", coalesceSeconds: 30 },
        }
      : null;
  } catch {
    return null;
  }
}

function parseProcessing(raw: string): EmailProcessingState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const state = value as Record<string, unknown>;
    switch (state.kind) {
      case "waiting":
        return { kind: "waiting" };
      case "scheduled":
        return typeof state.at === "number"
          ? { kind: "scheduled", at: state.at }
          : null;
      case "evaluating":
        return typeof state.startedAt === "number"
          ? { kind: "evaluating", startedAt: state.startedAt }
          : null;
      case "paused": {
        const reason = parseMailboxProcessingPauseReason(state.reason);
        return typeof state.pausedAt === "number" &&
          typeof state.policyVersion === "number" &&
          reason.ok
          ? {
              kind: "paused",
              reason: reason.value,
              pausedAt: state.pausedAt,
              policyVersion: state.policyVersion,
            }
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
