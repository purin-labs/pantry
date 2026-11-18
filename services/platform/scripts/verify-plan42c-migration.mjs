import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { singleDatabaseSchema } from "./single-database-schema.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = singleDatabaseSchema();
const migration = readFileSync(
  new URL("./plan42c-d1-remote-migration.sql", import.meta.url),
  "utf8",
);
const current = new DatabaseSync(":memory:");
const upgraded = new DatabaseSync(":memory:");
const tables = [
  "bakery_surface_effect_delivery",
  "bakery_agent_run_save",
  "bakery_agent_scenario_save",
  "bakery_surface_timeline_event",
];
try {
  current.exec(baseline);
  upgraded.exec(baseline);
  for (const table of tables.toReversed()) upgraded.exec(`DROP TABLE ${table}`);
  upgraded.exec(`
    INSERT INTO organisation (organisation_id, name, created_at) VALUES ('organisation_acceptance', 'Migration acceptance', 1);
    INSERT INTO app_user VALUES ('operator_acceptance', 'local', 'acceptance', 'migration@example.test', 'Operator', 1, 1, 1);
  `);
  upgraded.exec(migration);
  assert.deepEqual(schema(upgraded), schema(current));
  upgraded.exec(`
    INSERT INTO bakery_surface_effect_delivery VALUES (
      'effect_acceptance', 'organisation_acceptance', 'operator_acceptance', 'session', 'turn', 'request',
      'surface', 0, '${"a".repeat(64)}', '{}', 'dispatching', NULL, 100, 1, 1
    );
    INSERT INTO bakery_surface_timeline_event
      (organisation_id, user_id, session_id, turn_id, request_id, effect_id, event_kind, created_at)
      VALUES ('organisation_acceptance', 'operator_acceptance', 'session', 'turn', 'request', 'effect_acceptance', 'started', 1);
    UPDATE bakery_surface_effect_delivery SET state_kind = 'settled', receipt_json = '{}', updated_at = 2;
    INSERT INTO bakery_agent_run_save VALUES
      ('effect_acceptance', 'organisation_acceptance', 'operator_acceptance', '${"b".repeat(64)}', 'Reviewed run', 'approved', NULL, 2, 2);
    INSERT INTO bakery_agent_scenario_save VALUES
      ('effect_acceptance', 'organisation_acceptance', 'operator_acceptance', 'scenario', 'scenario_acceptance', '${"c".repeat(64)}', '{}', 'approved', NULL, 2, 2);
    UPDATE bakery_agent_run_save SET state_kind = 'saved', summary_json = '{}', updated_at = 3;
    UPDATE bakery_agent_scenario_save SET state_kind = 'saved', result_json = '{}', updated_at = 3;
  `);
  const before = contents(upgraded);
  upgraded.exec(migration);
  assert.deepEqual(contents(upgraded), before);
  assert.deepEqual(schema(upgraded), schema(current));
  assert.throws(rejectMissingReceipt.bind(null, upgraded), /CHECK constraint/);
  assert.throws(
    rejectMissingEffect.bind(null, upgraded),
    /FOREIGN KEY constraint/,
  );
  assert.throws(rejectDuplicateEvent.bind(null, upgraded), /UNIQUE constraint/);
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    upgraded
      .prepare(
        "SELECT name FROM organisation WHERE organisation_id = 'organisation_acceptance'",
      )
      .get().name,
    "Migration acceptance",
  );
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    migrationSha256: createHash("sha256").update(migration).digest("hex"),
    checks: [
      "baseline schema parity",
      "existing organisation preserved",
      "effect dispatch and settlement",
      "run and scenario save settlement",
      "reapplication preserves rows",
      "receipt lifecycle constraint",
      "foreign-key constraint",
      "timeline deduplication",
    ],
  };
  const output = `${root}output/acceptance/plan42c-release`;
  mkdirSync(output, { recursive: true });
  writeFileSync(
    `${output}/migration.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  current.close();
  upgraded.close();
}

function schema(database) {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE '%bakery%' ORDER BY name",
    )
    .all();
}

function contents(database) {
  const rows = {};
  for (const table of tables)
    rows[table] = database.prepare(`SELECT * FROM ${table}`).all();
  return rows;
}

function rejectMissingReceipt(database) {
  database.exec(
    "UPDATE bakery_surface_effect_delivery SET receipt_json = NULL WHERE state_kind = 'settled'",
  );
}

function rejectMissingEffect(database) {
  database.exec("UPDATE bakery_agent_run_save SET effect_id = 'missing'");
}

function rejectDuplicateEvent(database) {
  database.exec(
    "INSERT INTO bakery_surface_timeline_event (organisation_id, user_id, session_id, turn_id, request_id, effect_id, event_kind, created_at) SELECT organisation_id, user_id, session_id, turn_id, request_id, effect_id, event_kind, created_at FROM bakery_surface_timeline_event",
  );
}
