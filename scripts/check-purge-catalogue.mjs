// Refuses a regional table that the purge catalogue does not name (Refactor
// 15, refactor 5). Every table of the regional D1 baseline needs one entry in
// the purge catalogue: erase, pseudonymize or keep. Each table owner gives its
// entries in a purge-entries.ts file, and workers/platform/src/purge-catalogue.ts
// joins them (Refactor 17).
// The check also refuses:
// - an entry for a table that the baseline does not have, or a second entry;
// - an erase entry with no `where` for a table with no organisation_id column;
// - an order in which the purge would delete a row before a row that refers
//   to it: a table that the purge deletes from (erase or pseudonymize) comes
//   before every table that it refers to;
// - a kept table that refers to an erased one, unless its foreign key
//   cascades or sets NULL;
// - an R2 key root that a source template puts before an Organisation id
//   (`root/${organisationId}` or `root/${encodeURIComponent(organisationId)}`)
//   and that PURGE_R2_PREFIXES does not name, or names with the other
//   encoding.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const baseline = join(
  root,
  "workers/platform/migrations-regional/0001_current_schema.sql",
);
const cataloguePath = join(root, "workers/platform/src/purge-catalogue.ts");
const { PURGE_CATALOGUE } = await import(pathToFileURL(cataloguePath).href);
const r2PrefixesPath = join(root, "foundation/tenancy/data/purge-catalogue.ts");
const { PURGE_R2_PREFIXES } = await import(pathToFileURL(r2PrefixesPath).href);

const database = new DatabaseSync(":memory:");
database.exec(readFileSync(baseline, "utf8"));
const virtual = database
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
  )
  .all()
  .map((row) => row.name);
// The shadow tables of a full-text index belong to it.
const tables = database
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  )
  .all()
  .map((row) => row.name)
  .filter((name) => !virtual.some((owner) => name.startsWith(`${owner}_`)));

const problems = [];
const position = new Map();
for (const [index, entry] of PURGE_CATALOGUE.entries()) {
  if (position.has(entry.table))
    problems.push(`${entry.table} has a second entry`);
  position.set(entry.table, index);
  if (!tables.includes(entry.table))
    problems.push(
      `${entry.table} has an entry, but the regional baseline has no such table`,
    );
}

function columns(table) {
  return database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name);
}

function references(table) {
  return database
    .prepare(
      'SELECT DISTINCT "table" AS parent, on_delete AS onDelete FROM pragma_foreign_key_list(?)',
    )
    .all(table);
}

const deletes = (action) => action === "erase" || action === "pseudonymize";
for (const table of tables) {
  const index = position.get(table);
  if (index === undefined) {
    problems.push(
      `${table} has no entry in purge-catalogue.ts: add erase, pseudonymize or keep`,
    );
    continue;
  }
  const entry = PURGE_CATALOGUE[index];
  if (
    entry.action === "erase" &&
    entry.where === undefined &&
    !columns(table).includes("organisation_id")
  )
    problems.push(
      `${table} has no organisation_id column, so its erase entry needs a where`,
    );
  for (const { parent, onDelete } of references(table)) {
    if (parent === table || parent === "organisation") continue;
    const parentIndex = position.get(parent);
    if (parentIndex === undefined) continue;
    const parentEntry = PURGE_CATALOGUE[parentIndex];
    if (!deletes(parentEntry.action)) continue;
    if (deletes(entry.action) && index > parentIndex)
      problems.push(
        `${table} refers to ${parent}, so it must come before ${parent} in the catalogue`,
      );
    if (
      entry.action === "keep" &&
      parentEntry.action === "erase" &&
      onDelete !== "CASCADE" &&
      onDelete !== "SET NULL"
    )
      problems.push(
        `${table} is kept but refers to ${parent}, which the purge erases`,
      );
  }
}

const r2Roots = new Map(
  PURGE_R2_PREFIXES.map((entry) => [entry.root, entry.encoded]),
);
const r2Key =
  /`([a-z][a-z0-9-]*)\/\$\{(encodeURIComponent\()?[A-Za-z.]*[oO]rganisationId\b/gu;
function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "tests") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts"))
      yield full;
  }
}
for (const folder of [
  "foundation",
  "areas",
  "surfaces",
  "workers/platform/src",
])
  for (const file of sourceFiles(join(root, folder)))
    for (const [, keyRoot, encoder] of readFileSync(file, "utf8").matchAll(
      r2Key,
    )) {
      const where = file.slice(root.length);
      if (!r2Roots.has(keyRoot))
        problems.push(
          `${where} writes R2 keys under ${keyRoot}/, which PURGE_R2_PREFIXES does not name`,
        );
      else if (r2Roots.get(keyRoot) !== (encoder !== undefined))
        problems.push(
          `${where} encodes the Organisation id under ${keyRoot}/ unlike its PURGE_R2_PREFIXES entry`,
        );
    }

if (problems.length > 0) {
  console.error(`purge catalogue: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `purge catalogue: ${tables.length} regional tables and ${PURGE_R2_PREFIXES.length} R2 prefixes have an entry`,
);
