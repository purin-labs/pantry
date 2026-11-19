/**
 * The one writer of `connector_whatsapp_proposal.state` (Refactor 15,
 * refactor 13). Every move goes through `advanceWhatsAppProposal`, which
 * checks it against `WHATSAPP_REPLY_PROPOSAL_MACHINE` and writes it as a
 * compare-and-set on the state, the version and the send attempt that the
 * caller read. A move that finds the row changed is `stale`: the caller
 * reads the row again and decides, and never writes again blindly.
 *
 * The body is kept only while the version waits for approval or is being
 * sent. Every other state deletes it in the same statement that records the
 * move, so no path can leave a readable draft behind.
 */
import {
  machineTransition,
  type MachineEvent,
  type MachineGuard,
  type MachineGuardChecks,
  type MachineState,
} from "@purin-labs/std/state-machine";

import type { Result } from "../result";
import { writeActorTransition } from "./lifecycle/state-transition";
import {
  assertRequiredColumns,
  assertTableExists,
  runSchemaMigrations,
  type SchemaMigrationPlan,
  type SchemaTransaction,
} from "./schema-migrations";
import { WHATSAPP_REPLY_PROPOSAL_MACHINE } from "./whatsapp-reply-proposal.machine";

type ProposalMachine = typeof WHATSAPP_REPLY_PROPOSAL_MACHINE;

export type WhatsAppProposalState = MachineState<ProposalMachine>;
type WhatsAppProposalEvent = MachineEvent<ProposalMachine>;

/**
 * A `sending` attempt that has not settled in this time stopped with its
 * Connector: the call to Meta times out after 20 seconds.
 */
export const WHATSAPP_SEND_ATTEMPT_LEASE_MS =
  WHATSAPP_REPLY_PROPOSAL_MACHINE.states.sending.exit.afterMs;

/** The fields of a stored version that a move compares. */
type WhatsAppProposalClaim = Readonly<{
  proposalId: string;
  version: number;
  state: WhatsAppProposalState;
  sendAttemptId: string | null;
}>;

/** The data that each event writes besides the state. */
type WhatsAppProposalMove<Event extends WhatsAppProposalEvent> =
  Event extends "claim"
    ? Readonly<{ event: Event; attemptId: string; approvedBodyDigest: string }>
    : Event extends "provider_accepted" | "operator_saw_delivery"
      ? Readonly<{ event: Event; sentMessageId: string }>
      : Readonly<{ event: Event }>;

type WhatsAppProposalMoveError =
  | "whatsapp_proposal_transition_invalid"
  /** The row changed since the caller read it; read it again and decide. */
  | "whatsapp_proposal_transition_stale";

const BODY_STATES: ReadonlySet<WhatsAppProposalState> = new Set([
  "awaiting_approval",
  "sending",
]);

/** Writes one move of a stored version, checked against its machine. */
export function advanceWhatsAppProposal<Event extends WhatsAppProposalEvent>(
  sql: SqlStorage,
  from: WhatsAppProposalClaim,
  move: WhatsAppProposalMove<Event>,
  now: number,
  ...guards: [MachineGuard<ProposalMachine, Event>] extends [never]
    ? []
    : [MachineGuardChecks<ProposalMachine, Event>]
): Result<WhatsAppProposalState, WhatsAppProposalMoveError> {
  // The signature types the checks for `Event`; the machine reads them by
  // name, and a missing check refuses the move.
  const checks = guards[0] as never;
  const allowed = machineTransition(
    WHATSAPP_REPLY_PROPOSAL_MACHINE,
    from.state,
    move.event as WhatsAppProposalEvent,
    checks,
  );
  if (!allowed.allowed)
    return { ok: false, error: "whatsapp_proposal_transition_invalid" };
  const to: WhatsAppProposalState = allowed.to;
  const set: Record<string, SqlStorageValue> = {
    send_attempt_id: "attemptId" in move ? move.attemptId : null,
    updated_at: now,
  };
  if ("approvedBodyDigest" in move)
    set.approved_body_digest = move.approvedBodyDigest;
  if ("sentMessageId" in move) set.sent_message_id = move.sentMessageId;
  if (!BODY_STATES.has(to)) {
    set.nonce_b64 = null;
    set.ciphertext_b64 = null;
  }
  return writeActorTransition(sql, WHATSAPP_REPLY_PROPOSAL_MACHINE.store, {
    key: from.proposalId,
    from: from.state,
    value: to,
    match: { version: from.version, send_attempt_id: from.sendAttemptId },
    set,
  })
    ? { ok: true, value: to }
    : { ok: false, error: "whatsapp_proposal_transition_stale" };
}

/**
 * Stores a new version that waits for approval. The older versions of the
 * same proposal that still wait are superseded first; a version that is
 * being sent keeps its attempt.
 */
export function insertWhatsAppProposal(
  sql: SqlStorage,
  input: Readonly<{
    proposalId: string;
    version: number;
    caseId: string;
    customerWaId: string;
    author: "agent" | "human";
    bodyDigest: string;
    nonceB64: string;
    ciphertextB64: string;
    policyVersion: number;
    credentialGeneration: number;
    serviceWindowExpiresAt: number;
    expiresAt: number;
    now: number;
  }>,
): void {
  const older = sql
    .exec<Record<string, SqlStorageValue>>(
      `SELECT version FROM connector_whatsapp_proposal
        WHERE proposal_id = ? AND version < ? AND state = 'awaiting_approval'`,
      input.proposalId,
      input.version,
    )
    .toArray();
  for (const row of older)
    advanceWhatsAppProposal(
      sql,
      {
        proposalId: input.proposalId,
        version: Number(row.version),
        state: "awaiting_approval",
        sendAttemptId: null,
      },
      { event: "supersede" },
      input.now,
    );
  sql.exec(
    `INSERT INTO connector_whatsapp_proposal (
       proposal_id, version, case_id, customer_wa_id, author, body_digest, nonce_b64,
       ciphertext_b64, state, send_attempt_id, approved_body_digest, sent_message_id,
       policy_version, credential_generation, service_window_expires_at,
       expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (proposal_id, version) DO NOTHING`,
    input.proposalId,
    input.version,
    input.caseId,
    input.customerWaId,
    input.author,
    input.bodyDigest,
    input.nonceB64,
    input.ciphertextB64,
    input.policyVersion,
    input.credentialGeneration,
    input.serviceWindowExpiresAt,
    input.expiresAt,
    input.now,
    input.now,
  );
}

const PROPOSAL_COLUMNS = [
  "proposal_id",
  "version",
  "case_id",
  "customer_wa_id",
  "author",
  "body_digest",
  "nonce_b64",
  "ciphertext_b64",
  "state",
  "send_attempt_id",
  "approved_body_digest",
  "sent_message_id",
  "policy_version",
  "credential_generation",
  "service_window_expires_at",
  "expires_at",
  "created_at",
  "updated_at",
] as const;

/**
 * Version 1 is the table that the Connector created before Refactor 15. It
 * held an attempt as `approved`, with the attempt's life only in memory.
 * Version 2 stores the attempt as `sending` with its id. An `approved` row
 * belongs to an attempt that stopped with the release, so it becomes a
 * `sending` row of the attempt `refactor_15_recovery`, and the alarm fences
 * it as `send_indeterminate` when its lease has passed.
 */
const PROPOSAL_SCHEMA_PLAN: SchemaMigrationPlan = {
  key: "connector_whatsapp_proposal",
  currentVersion: 2,
  preservedTables: ["connector_whatsapp_proposal"],
  baseline: {
    version: 1,
    apply: createVersionOneProposalTable,
    validate: (sql) => assertTableExists(sql, "connector_whatsapp_proposal"),
  },
  steps: [
    {
      version: 2,
      apply: rebuildProposalWithSendAttempt,
      validate: validateProposalSchema,
    },
  ],
};

export function createConnectorWhatsAppProposalSchema(
  sql: SqlStorage,
  transaction: SchemaTransaction,
): void {
  runSchemaMigrations(sql, PROPOSAL_SCHEMA_PLAN, transaction);
}

function createVersionOneProposalTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_whatsapp_proposal (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    case_id TEXT NOT NULL,
    customer_wa_id TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('agent', 'human')),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    nonce_b64 TEXT,
    ciphertext_b64 TEXT,
    state TEXT NOT NULL CHECK (
      state IN (
        'awaiting_approval', 'approved', 'sent', 'send_indeterminate',
        'rejected', 'expired', 'superseded', 'taken_over', 'revoked'
      )
    ),
    approved_body_digest TEXT CHECK (
      approved_body_digest IS NULL OR length(approved_body_digest) = 64
    ),
    sent_message_id TEXT,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
    service_window_expires_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, version)
  )`);
}

function rebuildProposalWithSendAttempt(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE connector_whatsapp_proposal_next (
    proposal_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    case_id TEXT NOT NULL,
    customer_wa_id TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('agent', 'human')),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    nonce_b64 TEXT,
    ciphertext_b64 TEXT,
    state TEXT NOT NULL CHECK (
      state IN (
        'awaiting_approval', 'sending', 'sent', 'send_indeterminate',
        'rejected', 'expired', 'superseded', 'taken_over', 'revoked'
      )
    ),
    send_attempt_id TEXT,
    approved_body_digest TEXT CHECK (
      approved_body_digest IS NULL OR length(approved_body_digest) = 64
    ),
    sent_message_id TEXT,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
    service_window_expires_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, version),
    CHECK ((state = 'sending') = (send_attempt_id IS NOT NULL))
  )`);
  sql.exec(
    `INSERT INTO connector_whatsapp_proposal_next (
       proposal_id, version, case_id, customer_wa_id, author, body_digest, nonce_b64,
       ciphertext_b64, state, send_attempt_id, approved_body_digest, sent_message_id,
       policy_version, credential_generation, service_window_expires_at,
       expires_at, created_at, updated_at
     )
     SELECT proposal_id, version, case_id, customer_wa_id, author, body_digest, nonce_b64,
       ciphertext_b64,
       CASE WHEN state = 'approved' THEN 'sending' ELSE state END,
       CASE WHEN state = 'approved' THEN 'refactor_15_recovery' ELSE NULL END,
       approved_body_digest, sent_message_id, policy_version, credential_generation,
       service_window_expires_at, expires_at, created_at, updated_at
     FROM connector_whatsapp_proposal`,
  );
  sql.exec("DROP TABLE connector_whatsapp_proposal");
  sql.exec(
    "ALTER TABLE connector_whatsapp_proposal_next RENAME TO connector_whatsapp_proposal",
  );
}

function validateProposalSchema(sql: SqlStorage): void {
  assertTableExists(sql, "connector_whatsapp_proposal");
  assertRequiredColumns(sql, "connector_whatsapp_proposal", PROPOSAL_COLUMNS);
}
