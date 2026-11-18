// The schema of one database that holds both deployed schemas, for unit tests
// and local harnesses that run one database.
//
//   node services/platform/scripts/single-database-schema.mjs <out.sql | ->
//
// Production keeps global records and each Organisation's records in two
// databases (migrations-global, migrations-regional). A harness with one
// database loads both baselines into it: the global baseline as it is, then
// the regional baseline without the objects that the global baseline already
// creates (the Organisation and placement rows, the mutation receipts and
// their indexes). No foreign key crosses the two databases, as in production.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const platform = join(dirname(fileURLToPath(import.meta.url)), "..");

function objectNames(sql) {
  const database = new DatabaseSync(":memory:");
  database.exec(sql);
  const names = database
    .prepare("SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL")
    .all()
    .map((row) => `${row.type}:${row.name}`);
  database.close();
  return new Set(names);
}

/** The SQL of the one-database schema. */
export function singleDatabaseSchema() {
  const global = readFileSync(
    join(platform, "migrations-global/0001_current_schema.sql"),
    "utf8",
  );
  const regional = readFileSync(
    join(platform, "migrations-regional/0001_current_schema.sql"),
    "utf8",
  );
  const globalNames = objectNames(global);
  let rest = regional.replace(/^PRAGMA foreign_keys = ON;\n/mu, "");
  for (const entry of objectNames(regional)) {
    if (!globalNames.has(entry)) continue;
    const [type, name] = entry.split(":");
    const statement =
      type === "table"
        ? new RegExp(
            `^CREATE TABLE (?:IF NOT EXISTS )?${name} \\([\\s\\S]*?\\);\\n`,
            "mu",
          )
        : new RegExp(
            `^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${name}\\b[\\s\\S]*?;\\n`,
            "mu",
          );
    if (!statement.test(rest))
      throw new Error(`regional baseline: no removable statement for ${entry}`);
    rest = rest.replace(statement, "");
  }
  const sql = `${global}\n-- The regional baseline follows.\n${rest}`;
  const expected = new Set([...globalNames, ...objectNames(regional)]);
  const actual = objectNames(sql);
  if (
    actual.size !== expected.size ||
    [...expected].some((n) => !actual.has(n))
  )
    throw new Error("one-database schema does not hold both baselines");
  return sql;
}

/**
 * A new migrations folder that holds the one-database schema, for a harness
 * that reads a folder with readD1Migrations.
 */
export function singleDatabaseMigrations() {
  const directory = mkdtempSync(join(tmpdir(), "satyr-single-database-"));
  writeFileSync(
    join(directory, "0001_current_schema.sql"),
    singleDatabaseSchema(),
  );
  return directory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out === undefined)
    throw new Error("usage: single-database-schema.mjs <out.sql | ->");
  if (out === "-") process.stdout.write(singleDatabaseSchema());
  else writeFileSync(out, singleDatabaseSchema());
}
