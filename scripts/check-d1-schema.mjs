#!/usr/bin/env node
// Fails when a D1 database of a Worker profile lacks something that its
// baseline file (migrations*/0001_current_schema.sql) has: a table, a column,
// an index or a trigger. It checks every database that the profile binds, so
// each regional database is checked on its own. `deploy` runs it against
// production before it uploads the Worker, and `pnpm backend` runs it against
// the local databases before the Workers start.
//
//   node scripts/check-d1-schema.mjs <platform|commerce> <local|production>
//
// It also fails when an Organisation lacks the policy row of a catalogue
// capability (see capability-policy-rows.mjs); the Access read breaks then.
//
// `--persist-to <dir>` points a local check at another Wrangler state
// directory. Extra objects in a live database are listed and do not fail the
// check: a retired table stays until a patch drops it. CHECK constraints and
// defaults are not compared; SQLite cannot change them in place, so a patch
// rebuilds the table and the column checks above still see the new shape.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readWorkerEnvironment } from "./worker-environment.mjs";
import {
  MISSING_POLICY_QUERY,
  POLICY_TABLE,
} from "./capability-policy-rows.mjs";
import {
  SNAPSHOT_QUERY,
  missingFrom,
  snapshotOfBaseline,
  snapshotOfRows,
} from "./d1-schema-snapshot.mjs";
import { d1Rows } from "./d1-wrangler.mjs";

const root = resolve(import.meta.dirname, "..");
const LOCAL_STATE = ".wrangler/square-acceptance";
const [service, environment, ...options] = process.argv.slice(2);
const persistIndex = options.indexOf("--persist-to");
const persistTo =
  persistIndex === -1 ? LOCAL_STATE : (options[persistIndex + 1] ?? "");
if (persistTo === "" || (persistIndex !== -1 && environment !== "local"))
  throw new Error("--persist-to takes a directory and needs the local profile");

const config = readWorkerEnvironment(service, environment);
const databases = config.d1_databases ?? [];
if (databases.length === 0)
  throw new Error(`${service} binds no D1 database in ${environment}`);

let failed = false;
for (const database of databases) {
  const directory = database.migrations_dir ?? "migrations";
  const baseline = readFileSync(
    resolve(root, `services/${service}`, directory, "0001_current_schema.sql"),
    "utf8",
  );
  const expected = snapshotOfBaseline(baseline);
  const actual = snapshotOfRows(liveRows(database.binding));
  if (actual.size === 0) {
    failed = true;
    console.error(
      `EMPTY   ${database.binding} (${database.database_name}) has no schema.` +
        (environment === "local"
          ? " Run: pnpm --filter @seams/platform d1:migrate:local"
          : ""),
    );
    continue;
  }
  const problems = missingFrom(expected, actual);
  if (problems.length === 0 && expected.has(POLICY_TABLE))
    problems.push(...missingPolicyRows(database.binding));
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  const label = `${database.binding} (${database.database_name}, ${basename(directory)})`;
  if (problems.length === 0) {
    console.log(
      `ok      ${label}: ${expected.size} objects match` +
        (extra.length === 0 ? "" : `; ${extra.length} extra`),
    );
    continue;
  }
  failed = true;
  console.error(`DRIFT   ${label}: ${problems.length} difference(s)`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40)
    console.error(`  … and ${problems.length - 40} more`);
}
if (failed) {
  console.error(
    "\nFix what the lines above name, then run this check again. For a schema difference, apply the patch scripts of the missing changes (services/platform/scripts/*-d1-patch.sql). For a missing policy row, apply the backfill SQL.",
  );
  process.exitCode = 1;
}

function missingPolicyRows(binding) {
  const rows = liveRows(binding, MISSING_POLICY_QUERY);
  if (rows.length === 0) return [];
  const organisations = new Set(rows.map((row) => row.organisation_id));
  const lines = rows
    .slice(0, 10)
    .map(
      (row) =>
        `missing policy row: ${row.organisation_id} ${row.capability_id}`,
    );
  if (rows.length > 10) lines.push(`… and ${rows.length - 10} more`);
  lines.push(
    `${rows.length} missing across ${organisations.size} Organisation(s). Run: node scripts/capability-policy-backfill-sql.mjs > backfill.sql, then wrangler d1 execute ${binding} --file backfill.sql`,
  );
  return lines;
}

function liveRows(binding, query = SNAPSHOT_QUERY) {
  return d1Rows({ service, environment, persistTo }, binding, query);
}
