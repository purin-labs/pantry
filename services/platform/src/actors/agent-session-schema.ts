import { createSessionTurnSteeringSchema } from "./harness-steering";
import {
  assertRequiredColumns,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "@purin-labs/actor-runtime/actors/schema-migrations";
import {
  createSessionHarnessAuthoritySchema,
  SESSION_HARNESS_CHECKPOINT_COLUMNS,
  SESSION_HARNESS_HISTORY_COLUMNS,
  SESSION_HARNESS_LEASE_COLUMNS,
  SESSION_HARNESS_USAGE_COLUMNS,
  TURN_DELIVERY_SEGMENT_COLUMNS,
} from "./agent-session-harness-authority";
import { createSessionTurnContextSchema } from "./actor-journal";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import { createSessionInformationFlowSchema } from "./agent-session-information-flow";
import { createMessagePreparationSchema } from "./message-preparation-store";
import { runSessionOutboxSchemaMigrations } from "./agent-session-outbox-schema";
import { runTurnContinuationSchemaMigrations } from "./agent-session-continuation";

const SESSION_SCHEMA_KEY = "session_hot_schema";

const ACTOR_JOURNAL_COLUMNS = [
  "organisation_id",
  "stream_id",
  "sequence",
  "event_id",
  "envelope",
] as const;

export type AgentSessionPersistence = { readonly kind: "v33_canonical" };

export function initializeAgentSessionPersistence(
  sql: SqlStorage,
): AgentSessionPersistence {
  runSchemaMigrations(sql, SESSION_SCHEMA_PLAN, (operation) => operation());
  runSessionOutboxSchemaMigrations(sql);
  runTurnContinuationSchemaMigrations(sql);
  return { kind: "v33_canonical" };
}

/**
 * The Session schema. Version 33 is the baseline: production storage started
 * empty on 2026-10-09, after version 33 shipped (Refactor 10, step 2, D3).
 */
const SESSION_SCHEMA_PLAN: SchemaMigrationPlan = {
  key: SESSION_SCHEMA_KEY,
  currentVersion: CANONICAL_SESSION_SCHEMA_VERSION,
  preservedTables: [],
  baseline: {
    version: CANONICAL_SESSION_SCHEMA_VERSION,
    apply: createCanonicalSessionSchema,
    validate: validateCanonicalSessionPersistence,
  },
  steps: [],
};

export function createSessionSchema(sql: SqlStorage): void {
  initializeAgentSessionPersistence(sql);
}

function createCanonicalSessionSchema(sql: SqlStorage): void {
  createSessionMetaSchema(sql, "session_meta");
  createSessionExecutionSchema(sql);
}

function createSessionMetaSchema(
  sql: SqlStorage,
  table: "session_meta" | "session_meta_recovery",
): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
      session_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      track TEXT NOT NULL CHECK (track IN ('managed-agents', 'byo')),
      lifecycle_kind TEXT NOT NULL CHECK (
        lifecycle_kind IN (
          'sleeping', 'activating', 'processing', 'recovering', 'checkpointing',
          'cancelling', 'quarantined', 'terminal'
        )
      ),
      lifecycle_projection TEXT NOT NULL CHECK (json_valid(lifecycle_projection)),
      last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
      policy_version TEXT NOT NULL,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      terminal_at INTEGER,
      CHECK (
        (lifecycle_kind = 'terminal' AND terminal_at IS NOT NULL) OR
        (lifecycle_kind <> 'terminal' AND terminal_at IS NULL)
      )
    )`,
  );
}

function createSessionExecutionSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      organisation_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      turn_id TEXT,
      turn_sequence INTEGER,
      CHECK (
        (turn_id IS NULL AND turn_sequence IS NULL)
        OR (turn_id IS NOT NULL AND turn_sequence IS NOT NULL AND turn_sequence >= 0)
      )
    )`,
  );
  createSessionTurnStreamTable(sql);
  createSessionTurnContextSchema(sql);
  createSessionInformationFlowSchema(sql);
  createActorJournalSchema(sql);
  createSessionHarnessAuthoritySchema(sql);
  createSessionTurnSteeringSchema(sql);
  createSessionBudgetSchema(sql);
  createMessagePreparationSchema(sql);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_case_parent (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      case_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL UNIQUE,
      case_revision INTEGER NOT NULL CHECK (case_revision >= 0),
      session_id TEXT NOT NULL UNIQUE,
      assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json))
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_turn_attachment (
      turn_id TEXT PRIMARY KEY,
      organisation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attachments_json TEXT NOT NULL CHECK (json_valid(attachments_json)),
      links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json))
    )`,
  );
}

function createSessionBudgetSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_budget_account (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL UNIQUE CHECK (length(session_id) > 0),
      budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
      usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
      usage_cursor INTEGER NOT NULL CHECK (usage_cursor >= 0),
      state_kind TEXT NOT NULL CHECK (state_kind IN ('open', 'exhausted')),
      exhaustion_json TEXT,
      reservation_json TEXT NOT NULL CHECK (json_valid(reservation_json)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (state_kind = 'open' AND exhaustion_json IS NULL)
        OR (state_kind = 'exhausted' AND exhaustion_json IS NOT NULL AND json_valid(exhaustion_json))
      )
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_budget_reservation (
      reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) > 0),
      state_kind TEXT NOT NULL CHECK (state_kind IN ('active', 'indeterminate')),
      reservation_json TEXT NOT NULL CHECK (json_valid(reservation_json)),
      accepted_usage_json TEXT NOT NULL CHECK (json_valid(accepted_usage_json)),
      reason TEXT,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK ((state_kind = 'active' AND reason IS NULL) OR (state_kind = 'indeterminate' AND reason IS NOT NULL))
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_budget_event (
      sequence INTEGER PRIMARY KEY CHECK (sequence >= 0),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) > 0),
      operation_id TEXT NOT NULL UNIQUE CHECK (length(operation_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT,
      reservation_id TEXT,
      kind TEXT NOT NULL CHECK (length(kind) > 0),
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      at INTEGER NOT NULL CHECK (at >= 0)
    )`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS session_budget_reservation_state
     ON session_budget_reservation (session_id, state_kind)`,
  );
}

function createSessionTurnStreamTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_turn_stream (
      turn_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      organisation_id TEXT NOT NULL,
      input_digest TEXT NOT NULL DEFAULT '' CHECK (
        input_digest = '' OR (
          length(input_digest) = 64
          AND input_digest NOT GLOB '*[^0-9a-f]*'
        )
      ),
      state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= -1),
      error_detail TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (state IN ('running', 'complete') AND error_detail IS NULL)
        OR (state = 'failed' AND error_detail IS NOT NULL AND length(error_detail) > 0)
      ),
      CHECK (state != 'complete' OR last_sequence >= 0)
    )`,
  );
}

export function createActorJournalSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS actor_journal (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      stream_id TEXT NOT NULL CHECK (length(stream_id) > 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) > 0),
      envelope TEXT NOT NULL CHECK (json_valid(envelope) AND length(envelope) <= 16384),
      PRIMARY KEY (stream_id, sequence)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS actor_snapshot (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      stream_id TEXT NOT NULL CHECK (length(stream_id) > 0),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      reducer_schema_version INTEGER NOT NULL CHECK (reducer_schema_version >= 1),
      state_digest TEXT NOT NULL CHECK (
        length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'
      ),
      state_projection TEXT NOT NULL CHECK (json_valid(state_projection)),
      PRIMARY KEY (stream_id, last_sequence)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS actor_inbox (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      source TEXT NOT NULL CHECK (length(source) > 0),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
      operation_id TEXT NOT NULL UNIQUE CHECK (length(operation_id) > 0),
      outcome TEXT NOT NULL CHECK (json_valid(outcome)),
      PRIMARY KEY (source, idempotency_key)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS actor_outbox (
      effect_id TEXT PRIMARY KEY CHECK (length(effect_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      originating_event_id TEXT NOT NULL CHECK (length(originating_event_id) > 0),
      request_envelope TEXT NOT NULL CHECK (json_valid(request_envelope)),
      state_kind TEXT NOT NULL CHECK (
        state_kind IN ('pending', 'dispatching', 'settled', 'reconciled', 'indeterminate')
      ),
      state_projection TEXT NOT NULL CHECK (json_valid(state_projection)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    )`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS consumer_checkpoint (
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      consumer TEXT NOT NULL CHECK (length(consumer) > 0),
      stream_id TEXT NOT NULL CHECK (length(stream_id) > 0),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      PRIMARY KEY (consumer, stream_id)
    )`,
  );
}

function validateCanonicalSessionPersistence(sql: SqlStorage): void {
  assertRequiredColumns(sql, "session_meta", [
    "session_id",
    "organisation_id",
    "thread_key",
    "track",
    "lifecycle_kind",
    "lifecycle_projection",
    "last_event_sequence",
    "policy_version",
    "started_at",
    "terminal_at",
  ]);
  assertRequiredColumns(sql, "actor_journal", ACTOR_JOURNAL_COLUMNS);
  assertRequiredColumns(sql, "session_event", [
    "seq",
    "organisation_id",
    "request_id",
    "kind",
    "payload",
    "at",
    "archived",
    "turn_id",
    "turn_sequence",
  ]);
  assertRequiredColumns(sql, "session_turn_stream", [
    "turn_id",
    "request_id",
    "organisation_id",
    "input_digest",
    "state",
    "last_sequence",
    "error_detail",
    "started_at",
    "updated_at",
  ]);
  assertRequiredColumns(sql, "session_turn_context", [
    "turn_id",
    "organisation_id",
    "session_id",
    "bundle_digest",
    "bundle_json",
  ]);
  assertRequiredColumns(sql, "session_information_flow_observation", [
    "organisation_id",
    "session_id",
    "evidence_digest",
    "evidence_json",
    "recorded_at",
  ]);
  assertRequiredColumns(sql, "session_information_flow_revision", [
    "organisation_id",
    "session_id",
    "revision",
    "turn_id",
    "authority_partition_digest",
    "context_digest",
    "context_json",
    "committed_at",
  ]);
  assertRequiredColumns(sql, "session_information_flow_turn_binding", [
    "organisation_id",
    "session_id",
    "turn_id",
    "authority_partition_digest",
    "revision",
    "context_digest",
    "binding_json",
    "prepared_at",
  ]);
  assertRequiredColumns(
    sql,
    "session_harness_lease",
    SESSION_HARNESS_LEASE_COLUMNS,
  );
  assertRequiredColumns(
    sql,
    "session_harness_checkpoint",
    SESSION_HARNESS_CHECKPOINT_COLUMNS,
  );
  assertRequiredColumns(sql, "session_harness_checkpoint_payload", [
    "session_id",
    "turn_id",
    "last_sequence",
    "chunk_index",
    "payload",
  ]);
  assertRequiredColumns(
    sql,
    "turn_delivery_segment",
    TURN_DELIVERY_SEGMENT_COLUMNS,
  );
  assertRequiredColumns(
    sql,
    "session_harness_history",
    SESSION_HARNESS_HISTORY_COLUMNS,
  );
  assertRequiredColumns(
    sql,
    "session_harness_usage",
    SESSION_HARNESS_USAGE_COLUMNS,
  );
  assertRequiredColumns(sql, "session_budget_account", [
    "singleton",
    "organisation_id",
    "session_id",
    "budget_json",
    "usage_json",
    "usage_cursor",
    "state_kind",
    "exhaustion_json",
    "reservation_json",
    "updated_at",
  ]);
  assertRequiredColumns(sql, "session_budget_reservation", [
    "reservation_id",
    "organisation_id",
    "session_id",
    "run_id",
    "state_kind",
    "reservation_json",
    "accepted_usage_json",
    "reason",
    "updated_at",
  ]);
  assertRequiredColumns(sql, "session_budget_event", [
    "sequence",
    "event_id",
    "operation_id",
    "organisation_id",
    "session_id",
    "run_id",
    "reservation_id",
    "kind",
    "payload",
    "at",
  ]);
}
