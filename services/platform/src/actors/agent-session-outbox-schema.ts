import {
  assertRequiredColumns,
  assertTableExists,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "./schema-migrations";
import type { CountRow } from "./sql-rows";

/**
 * The Session's `actor_outbox` after Refactor 15: a terminal `quarantined`
 * state and a count of failed recovery attempts. The Session baseline
 * (version 33) creates the table; this plan has its own key, so the change
 * moves no Session or registry schema version and needs no activation
 * advance. Version 1 is the table as the baseline creates it.
 *
 * Version 3 (Plan 95 step 3) deletes the rows of the turn billing that went
 * to the Console (effect ids `account_execution:*`). Pantry no longer bills a
 * turn, and an open row of a Console test account would keep a Session from
 * its end and from a relocation.
 */
const SESSION_OUTBOX_SCHEMA_PLAN: SchemaMigrationPlan = {
  key: "session_actor_outbox",
  currentVersion: 3,
  preservedTables: ["actor_outbox"],
  baseline: {
    version: 1,
    apply: (sql) => assertTableExists(sql, "actor_outbox"),
    validate: (sql) => assertTableExists(sql, "actor_outbox"),
  },
  steps: [
    {
      version: 2,
      apply: rebuildActorOutboxWithQuarantine,
      validate: (sql) =>
        assertRequiredColumns(sql, "actor_outbox", [
          "effect_id",
          "organisation_id",
          "originating_event_id",
          "request_envelope",
          "state_kind",
          "state_projection",
          "updated_at",
          "recovery_attempts",
        ]),
    },
    {
      version: 3,
      apply: deleteConsoleBillingRows,
      validate: assertNoConsoleBillingRows,
      rowCountChanges: { actor_outbox: "may_shrink" },
    },
  ],
};

const CONSOLE_BILLING_ROWS = "effect_id GLOB 'account_execution:*'";

function deleteConsoleBillingRows(sql: SqlStorage): void {
  sql.exec(`DELETE FROM actor_outbox WHERE ${CONSOLE_BILLING_ROWS}`);
}

/** Only the billing rows leave; the row count check allows no other loss. */
function assertNoConsoleBillingRows(sql: SqlStorage): void {
  assertTableExists(sql, "actor_outbox");
  const left = sql
    .exec<CountRow>(
      `SELECT COUNT(*) AS count FROM actor_outbox WHERE ${CONSOLE_BILLING_ROWS}`,
    )
    .toArray()[0]?.count;

  if (left !== 0) {
    throw new Error(`schema_console_billing_rows_left:${left}`);
  }
}

/** Runs after the Session plan, in the same transaction. */
export function runSessionOutboxSchemaMigrations(sql: SqlStorage): void {
  runSchemaMigrations(sql, SESSION_OUTBOX_SCHEMA_PLAN, (operation) =>
    operation(),
  );
}

function rebuildActorOutboxWithQuarantine(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE actor_outbox_next (
      effect_id TEXT PRIMARY KEY CHECK (length(effect_id) > 0),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      originating_event_id TEXT NOT NULL CHECK (length(originating_event_id) > 0),
      request_envelope TEXT NOT NULL CHECK (json_valid(request_envelope)),
      state_kind TEXT NOT NULL CHECK (
        state_kind IN (
          'pending', 'dispatching', 'settled', 'reconciled', 'indeterminate',
          'quarantined'
        )
      ),
      state_projection TEXT NOT NULL CHECK (json_valid(state_projection)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0)
    )`,
  );
  sql.exec(
    `INSERT INTO actor_outbox_next (
      effect_id, organisation_id, originating_event_id, request_envelope,
      state_kind, state_projection, updated_at
    )
    SELECT effect_id, organisation_id, originating_event_id, request_envelope,
      state_kind, state_projection, updated_at
    FROM actor_outbox`,
  );
  sql.exec("DROP TABLE actor_outbox");
  sql.exec("ALTER TABLE actor_outbox_next RENAME TO actor_outbox");
}
