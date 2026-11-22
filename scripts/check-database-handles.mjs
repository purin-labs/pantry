#!/usr/bin/env node
// Each D1 handle in the platform says which database it is (Refactor 12).
//
// 1. Only foundation/kernel/database-handles.ts makes a handle: no other
//    source file may cast to GlobalDatabase, OrganisationDatabase or
//    SingleDatabase (or their sessions), and only the placement selection in
//    organisation-execution-scope.ts may call organisationDatabase().
// 2. A plain D1Database or D1DatabaseSession may not spread: the count in each
//    source file may not grow past scripts/database-handles-ratchet.json. A
//    plain handle is right only for code that names the tables in both
//    databases (organisation, organisation_placement,
//    control_mutation_receipt) or that copies rows between them. Run
//    `node scripts/refactor-12/database-roles.mjs --write` to name the
//    database of a new handle.
// 3. Only services/platform/src/data/shared-rows/ writes the three tables that
//    are in both baselines: no other source file may INSERT, UPDATE, DELETE or
//    REPLACE a row of organisation, organisation_placement or
//    control_mutation_receipt (docs/refactor-12.md, part 2).
//
//   node scripts/check-database-handles.mjs            check
//   node scripts/check-database-handles.mjs --update   lower entries, drop zero or deleted files
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { filesIn, PLATFORM_SOURCE } from "./lib/source-roots.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/database-handles-ratchet.json";
const HANDLES = "foundation/kernel/database-handles.ts";
const MAKER_ALLOWED = new Set([
  HANDLES,
  "services/platform/src/organisation-execution-scope.ts",
]);

const mode = process.argv[2] ?? "check";
if (!["check", "--update"].includes(mode)) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}

const CAST =
  /\bas\s+(?:unknown\s+as\s+)?(?:Global|Organisation|Single)Database(?:Session)?\b/g;
const MAKER = /\b(?:globalDatabase|organisationDatabase|singleDatabase)\(/g;
const PLAIN = /\bD1Database(?:Session)?\b/g;
const SHARED_ROWS = "services/platform/src/data/shared-rows/";
const SHARED_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+"?(?:organisation|organisation_placement|control_mutation_receipt)\b(?!_)/g;

const failures = [];
const counts = {};
for (const path of filesIn(root, PLATFORM_SOURCE, (name) =>
  name.endsWith(".ts"),
)) {
  const name = relative(root, path);
  if (name === HANDLES) continue;
  const text = readFileSync(path, "utf8");
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  for (const match of text.matchAll(CAST))
    failures.push(`${name}:${lineOf(match.index)}: casts to a database handle`);
  if (!MAKER_ALLOWED.has(name))
    for (const match of text.matchAll(MAKER))
      failures.push(`${name}:${lineOf(match.index)}: makes a database handle`);
  if (!name.startsWith(SHARED_ROWS))
    for (const match of text.matchAll(SHARED_WRITE))
      failures.push(
        `${name}:${lineOf(match.index)}: writes a shared row; use data/shared-rows/`,
      );
  const plain = [...text.matchAll(PLAIN)].length;
  if (plain) counts[name] = plain;
}

const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
if (mode === "--update") {
  const next = {};
  for (const [name, count] of Object.entries(baseline))
    if (counts[name]) next[name] = Math.min(count, counts[name]);
  writeFileSync(
    join(root, BASELINE),
    JSON.stringify(Object.fromEntries(Object.entries(next).sort()), null, 2) +
      "\n",
  );
}
for (const [name, count] of Object.entries(counts)) {
  const allowed = baseline[name] ?? 0;
  if (count > allowed)
    failures.push(
      `${name}: ${count} plain D1 handles, ${allowed} allowed; name the database (GlobalDatabase or OrganisationDatabase)`,
    );
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `database handles: ${Object.values(counts).reduce((a, b) => a + b, 0)} plain handles in ${Object.keys(counts).length} files, none new`,
);
