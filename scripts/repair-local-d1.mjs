#!/usr/bin/env node
// Brings each local D1 database of a Worker profile up to its baseline with
// the patch scripts that deployed databases take
// (services/platform/scripts/*d1*.sql), then adds the missing capability
// policy rows. `pnpm backend` runs it when check-d1-schema.mjs finds drift.
//
//   node scripts/repair-local-d1.mjs <platform|commerce> [--persist-to <dir>]
//
// A local database keeps the schema of the day that it was made: the
// baselines are edited in place and Wrangler never applies them again. Patch
// files carry no ledger, and some of them may run only once, so this script
// does not run them blindly. It tries each patch, in the order in which git
// added them, on an in-memory copy of the live schema. It keeps a patch only
// when the patch runs and leaves less drift with no new difference; then it
// runs that patch on the local database. It repeats until no patch helps.
//
// A local database that was once one combined database can keep old triggers
// that the baseline does not have. When such a trigger makes a patch fail,
// the script drops the extra triggers in the copy, and on the database when
// the patch then helps. It changes local databases only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { d1Execute, d1Rows } from "./d1-wrangler.mjs";

const root = resolve(import.meta.dirname, "..");
const PATCH_DIRECTORY = "services/platform/scripts";
const SCHEMA_QUERY = `
SELECT type, name, sql FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL
  AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
  AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
`;

const [service, ...options] = process.argv.slice(2);
const persistIndex = options.indexOf("--persist-to");
const persistTo =
  persistIndex === -1
    ? ".wrangler/square-acceptance"
    : (options[persistIndex + 1] ?? "");
if (persistTo === "") throw new Error("--persist-to takes a directory");
const target = { service, environment: "local", persistTo };

const config = readWorkerEnvironment(service, "local");
const patches = patchScripts();
for (const database of config.d1_databases ?? []) {
  const directory = database.migrations_dir ?? "migrations";
  const expected = snapshotOfBaseline(
    readFileSync(
      resolve(
        root,
        `services/${service}`,
        directory,
        "0001_current_schema.sql",
      ),
      "utf8",
    ),
  );
  repairSchema(database.binding, expected);
  if (expected.has(POLICY_TABLE)) repairPolicyRows(database.binding);
}

function repairSchema(binding, expected) {
  const schema = d1Rows(target, binding, SCHEMA_QUERY);
  if (schema.length === 0) return; // An empty database needs d1:migrate:local.
  const extraTriggers = schema
    .filter((row) => row.type === "trigger" && !expected.has(row.name))
    .map((row) => row.name);
  const steps = [];
  let problems = new Set(simulate(schema, steps, expected).problems);
  if (problems.size === 0) return;
  const unused = new Set(patches.map((patch) => patch.path));
  let progress = true;
  while (problems.size > 0 && progress) {
    progress = false;
    for (const patch of patches) {
      if (!unused.has(patch.path)) continue;
      const step = helpfulStep(schema, steps, expected, problems, patch, {
        extraTriggers,
      });
      if (step === null) continue;
      steps.push(step);
      unused.delete(patch.path);
      problems = new Set(step.problems);
      progress = true;
    }
  }
  if (steps.length === 0) {
    console.error(
      `repair  ${binding}: no patch script removes its drift. Write or fix the patch.`,
    );
    return;
  }
  for (const step of steps) {
    if (step.dropTriggers.length > 0) {
      const dropped = d1Execute(target, binding, {
        command: step.dropTriggers
          .map((name) => `DROP TRIGGER IF EXISTS ${name};`)
          .join(" "),
      });
      if (!dropped.ok) return refused(binding, "the old triggers", dropped);
      console.log(
        `repair  ${binding}: dropped old triggers ${step.dropTriggers.join(", ")}`,
      );
    }
    const applied = d1Execute(target, binding, { file: step.path });
    if (!applied.ok) return refused(binding, step.name, applied);
    console.log(`repair  ${binding}: applied ${step.name}`);
  }
}

/**
 * The patch as a step when it runs on the simulated schema and leaves less
 * drift and no new difference; null otherwise.
 */
function helpfulStep(schema, steps, expected, problems, patch, options) {
  const alreadyDropped = new Set(steps.flatMap((step) => step.dropTriggers));
  const oldTriggers = options.extraTriggers.filter(
    (name) => !alreadyDropped.has(name),
  );
  for (const drops of oldTriggers.length === 0 ? [[]] : [[], oldTriggers]) {
    const step = { ...patch, dropTriggers: drops, problems: [] };
    const result = simulate(schema, [...steps, step], expected);
    if (!result.ok) continue;
    const after = new Set(result.problems);
    if (after.size >= problems.size) continue;
    if ([...after].some((problem) => !problems.has(problem))) continue;
    step.problems = result.problems;
    return step;
  }
  return null;
}

/** The live schema in memory, with the steps applied, compared to the baseline. */
function simulate(schema, steps, expected) {
  const database = new DatabaseSync(":memory:");
  try {
    // Virtual tables first: they make their own shadow tables, whose rows
    // then fail to create and are skipped.
    const order = { table: 1, index: 2, trigger: 3 };
    const statements = [...schema].sort(
      (left, right) =>
        order[left.type] - order[right.type] ||
        Number(!/^CREATE VIRTUAL/iu.test(left.sql)) -
          Number(!/^CREATE VIRTUAL/iu.test(right.sql)),
    );
    for (const row of statements) {
      try {
        database.exec(row.sql);
      } catch {
        // A shadow table of a virtual table already exists.
      }
    }
    for (const step of steps) {
      for (const name of step.dropTriggers)
        database.exec(`DROP TRIGGER IF EXISTS ${name}`);
      database.exec("BEGIN");
      try {
        database.exec(step.sql);
        database.exec("COMMIT");
      } catch {
        database.exec("ROLLBACK");
        return { ok: false, problems: [] };
      }
    }
    const actual = snapshotOfRows(database.prepare(SNAPSHOT_QUERY).all());
    return { ok: true, problems: missingFrom(expected, actual) };
  } finally {
    database.close();
  }
}

function repairPolicyRows(binding) {
  let missing;
  try {
    missing = d1Rows(target, binding, MISSING_POLICY_QUERY);
  } catch {
    return; // The schema still drifts; the check names it.
  }
  if (missing.length === 0) return;
  const sql = spawnSync(
    process.execPath,
    [resolve(root, "scripts/capability-policy-backfill-sql.mjs")],
    { cwd: root, encoding: "utf8" },
  );
  if (sql.status !== 0)
    throw new Error(`The policy backfill SQL failed: ${sql.stderr}`);
  const file = join(mkdtempSync(join(tmpdir(), "satyr-d1-")), "backfill.sql");
  writeFileSync(file, sql.stdout);
  const applied = d1Execute(target, binding, { file });
  if (!applied.ok) return refused(binding, "the policy backfill", applied);
  console.log(
    `repair  ${binding}: added ${missing.length} missing capability policy row(s)`,
  );
}

function refused(binding, what, result) {
  console.error(
    `repair  ${binding}: D1 refused ${what}: ${result.error.slice(0, 600)}`,
  );
}

/** Every patch script, oldest first: by the commit that added it, then by name. */
function patchScripts() {
  const directory = resolve(root, PATCH_DIRECTORY);
  const added = new Map();
  const log = spawnSync(
    "git",
    [
      "log",
      "--diff-filter=A",
      "--format=%x00%ct",
      "--name-only",
      "--",
      PATCH_DIRECTORY,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  for (const entry of (log.stdout ?? "").split("\0")) {
    const [time, ...files] = entry.trim().split("\n");
    for (const file of files) {
      const name = file.trim().split("/").pop();
      // git log lists the newest commit first; keep the oldest addition.
      if (name) added.set(name, Number(time));
    }
  }
  return readdirSync(directory)
    .filter((name) => /d1.*\.sql$/u.test(name))
    .map((name) => ({
      name,
      path: join(directory, name),
      sql: readFileSync(join(directory, name), "utf8"),
      time: added.get(name) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (left, right) =>
        left.time - right.time || (left.name < right.name ? -1 : 1),
    );
}
