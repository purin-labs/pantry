import { deviceCommandSchemaStatements } from "./device-command";
import { cobotDispatchSchemaStatements } from "./device-fleet-cobot";
import { printerJobSchemaStatements } from "./device-fleet-printer";
import { terminalCollectionSchemaStatements } from "./device-fleet-terminal";
import {
  assertRequiredColumns,
  assertTableExists,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "./schema-migrations";

/**
 * The DeviceFleetActor's tables (Plan 85). Version 1 is the shape that the
 * Actor created before it had a plan, so an Actor with those tables applies
 * the baseline as no change. Version 2 adds `device_command` (Refactor 15,
 * refactor 6), version 3 `terminal_collection` and version 4 `printer_job`
 * (Plan 90). Version 5 adds `cobot_dispatch` and `cobot_run_watch` (Plan 24).
 */
const DEVICE_FLEET_SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS device_fleet_scope (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     organisation_id TEXT NOT NULL,
     location_id TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gateway_presence (
     gateway_id TEXT PRIMARY KEY,
     last_heard_at INTEGER,
     announced_state TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS device_sample (
     source_key TEXT NOT NULL,
     gateway_id TEXT NOT NULL,
     name TEXT NOT NULL,
     bucket INTEGER NOT NULL,
     value REAL NOT NULL,
     unit TEXT NOT NULL,
     PRIMARY KEY (gateway_id, source_key, name, bucket)
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_upkeep (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     pruned_at INTEGER NOT NULL
   )`,
];

const DEVICE_FLEET_V1_TABLES = [
  "device_fleet_scope",
  "gateway_presence",
  "device_sample",
  "fleet_upkeep",
] as const;

const DEVICE_FLEET_SCHEMA_PLAN: SchemaMigrationPlan = {
  key: "device_fleet",
  currentVersion: 5,
  preservedTables: DEVICE_FLEET_V1_TABLES,
  baseline: {
    version: 1,
    apply: (sql) => {
      for (const statement of DEVICE_FLEET_SCHEMA_V1) sql.exec(statement);
    },
    validate: validateV1,
  },
  steps: [
    {
      version: 2,
      apply: (sql) => {
        for (const statement of deviceCommandSchemaStatements())
          sql.exec(statement);
      },
      validate: (sql) => {
        validateV1(sql);
        assertRequiredColumns(sql, "device_command", [
          "command_id",
          "gateway_id",
          "device_id",
          "source_key",
          "kind",
          "state",
          "created_at",
          "sent_at",
          "acked_at",
        ]);
      },
    },
    {
      version: 3,
      apply: (sql) => {
        for (const statement of terminalCollectionSchemaStatements())
          sql.exec(statement);
      },
      validate: (sql) => {
        validateV1(sql);
        assertRequiredColumns(sql, "terminal_collection", [
          "gateway_id",
          "source_key",
          "request_id",
          "payment_attempt_id",
          "checkout_id",
          "amount_minor",
          "currency",
          "payment_method",
          "state",
          "expires_at",
          "updated_at",
        ]);
      },
    },
    {
      // Plan 90 Phase 5: receipt printer and cash drawer tasks.
      version: 4,
      apply: (sql) => {
        for (const statement of printerJobSchemaStatements())
          sql.exec(statement);
      },
      validate: (sql) => {
        validateV1(sql);
        assertRequiredColumns(sql, "printer_job", [
          "request_id",
          "gateway_id",
          "source_key",
          "task",
          "checkout_id",
          "message_json",
          "state",
          "replayed",
          "created_at",
          "updated_at",
        ]);
      },
    },
    {
      // Plan 24 S4: the cobot dispatch ledger and the runs that watch devices.
      version: 5,
      apply: (sql) => {
        for (const statement of cobotDispatchSchemaStatements())
          sql.exec(statement);
      },
      validate: (sql) => {
        validateV1(sql);
        assertRequiredColumns(sql, "cobot_dispatch", [
          "request_id",
          "gateway_id",
          "device_id",
          "source_key",
          "run_actor_id",
          "run_id",
          "task_id",
          "message_json",
          "state",
          "last_report_json",
          "created_at",
          "updated_at",
        ]);
        assertRequiredColumns(sql, "cobot_run_watch", [
          "run_actor_id",
          "gateway_id",
          "source_key",
        ]);
        assertRequiredColumns(sql, "cobot_run_known", ["run_actor_id"]);
      },
    },
  ],
};

export function runDeviceFleetSchemaMigrations(
  storage: DurableObjectStorage,
): void {
  runSchemaMigrations(storage.sql, DEVICE_FLEET_SCHEMA_PLAN, (operation) =>
    storage.transactionSync(operation),
  );
}

function validateV1(sql: SqlStorage): void {
  for (const table of DEVICE_FLEET_V1_TABLES) assertTableExists(sql, table);
}
