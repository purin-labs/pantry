import {
  assertRequiredColumns,
  assertTableExists,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "./schema-migrations";

/**
 * The Case's own tables, version 1. A schema change adds a step after the
 * baseline (Refactor 10, step 2). The lifecycle, conversation and goal tables
 * belong to their own modules.
 */
const CASE_SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS case_context_projection_outbox (
    entry_id TEXT PRIMARY KEY NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS case_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), organisation_id TEXT NOT NULL,
    case_id TEXT NOT NULL, purpose TEXT NOT NULL, workspace_revision TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0), lifecycle_json TEXT NOT NULL CHECK (json_valid(lifecycle_json))
  )`,
  `CREATE TABLE IF NOT EXISTS case_trigger (
    trigger_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (json_valid(payload))
  )`,
  `CREATE TABLE IF NOT EXISTS case_binding (
    binding_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (json_valid(payload))
  )`,
  `CREATE TABLE IF NOT EXISTS case_assignment (
    assignment_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
    lifecycle_json TEXT NOT NULL CHECK (json_valid(lifecycle_json))
  )`,
  `CREATE TABLE IF NOT EXISTS case_proposal (
    proposal_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (json_valid(payload)),
    acceptance_json TEXT NOT NULL CHECK (json_valid(acceptance_json))
  )`,
  `CREATE TABLE IF NOT EXISTS case_commerce_proposal (
    proposal_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (json_valid(payload)),
    acceptance_json TEXT NOT NULL CHECK (json_valid(acceptance_json))
  )`,
  `CREATE TABLE IF NOT EXISTS case_commerce_approval (
    action_nonce TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL CHECK (json_valid(payload))
  )`,
  `CREATE TABLE IF NOT EXISTS case_email_proposal (
    proposal_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    PRIMARY KEY (proposal_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS case_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE,
    digest TEXT NOT NULL, preview TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)),
    request_authority_json TEXT NOT NULL CHECK (json_valid(request_authority_json)),
    visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json)),
    visibility_key TEXT NOT NULL,
    flow_label_json TEXT CHECK (flow_label_json IS NULL OR json_valid(flow_label_json)),
    authority_scope_json TEXT CHECK (authority_scope_json IS NULL OR json_valid(authority_scope_json)),
    accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS case_output (
    output_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE, lifecycle_json TEXT NOT NULL CHECK (json_valid(lifecycle_json))
  )`,
];

const CASE_TABLES = [
  "case_context_projection_outbox",
  "case_meta",
  "case_trigger",
  "case_binding",
  "case_assignment",
  "case_proposal",
  "case_commerce_proposal",
  "case_commerce_approval",
  "case_email_proposal",
  "case_journal",
  "case_output",
] as const;

/**
 * Version 2 (Refactor 15, refactor 9): when the Case made each assignment, so
 * that an assignment which never began can be abandoned once it is old. A
 * row from before this version has none and counts as old.
 */
function addAssignmentTime(sql: SqlStorage): void {
  sql.exec("ALTER TABLE case_assignment ADD COLUMN assigned_at INTEGER");
}

const CASE_SCHEMA_PLAN: SchemaMigrationPlan = {
  key: "case",
  currentVersion: 2,
  preservedTables: [],
  baseline: {
    version: 1,
    apply: (sql) => {
      for (const statement of CASE_SCHEMA_V1) sql.exec(statement);
    },
    validate: (sql) => {
      for (const table of CASE_TABLES) assertTableExists(sql, table);
    },
  },
  steps: [
    {
      version: 2,
      apply: addAssignmentTime,
      validate: (sql) =>
        assertRequiredColumns(sql, "case_assignment", ["assigned_at"]),
    },
  ],
};

/** Creates or checks the Case's tables; the caller holds the transaction. */
export function runCaseSchemaMigrations(sql: SqlStorage): void {
  runSchemaMigrations(sql, CASE_SCHEMA_PLAN, (operation) => operation());
}
