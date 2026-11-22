// Refuses a write of a machine's state outside the machine's owner module
// (Refactor 15, S4). Each `*.machine.ts` definition names its `store` (the
// table and the state column) and its `owner`. This check scans the source
// for SQL that writes that column: `UPDATE <table> SET … <column>`, and an
// `INSERT INTO <table> (… <column> …)`, which covers `ON CONFLICT … DO
// UPDATE`. A writer outside the owner must be listed in
// `scripts/state-writers-ratchet.json`, and its count may only fall. Run
// `node scripts/check-state-writers.mjs --update` when a writer moves.
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { filesIn, SOURCE_ROOTS } from "./lib/source-roots.mjs";

const root = new URL("..", import.meta.url).pathname;
const ratchetPath = join(root, "scripts/state-writers-ratchet.json");
const update = process.argv.includes("--update");

const sources = filesIn(root, SOURCE_ROOTS, (name) =>
  /\.(ts|tsx|mjs)$/u.test(name),
);
const productSources = sources.filter(
  (path) =>
    !/\/tests?\//u.test(path) &&
    !/\.test\.tsx?$/u.test(path) &&
    !path.endsWith(".machine.ts"),
);

const machines = [];
for (const path of sources.filter((file) => file.endsWith(".machine.ts"))) {
  const module = await import(pathToFileURL(path).href);
  for (const machine of Object.values(module))
    if (
      typeof machine === "object" &&
      machine !== null &&
      "store" in machine &&
      machine.store !== undefined &&
      typeof machine.owner === "string"
    )
      machines.push(machine);
}

/** The end of the SQL text that starts at `start`: its closing quote. */
function statementAt(text, start) {
  const end = text.slice(start, start + 2_000).search(/[`"';]/u);
  return text.slice(start, end < 0 ? start + 2_000 : start + end);
}

function writesIn(text, table, column) {
  let count = 0;
  const columnWord = new RegExp(`\\b${column}\\b`, "u");
  const writes = new RegExp(
    `\\b(?:UPDATE\\s+${table}\\s+SET|INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b)`,
    "giu",
  );
  for (const match of text.matchAll(writes)) {
    const statement = statementAt(text, match.index);
    // An UPDATE writes the column only in its SET clause; the WHERE clause
    // may name it as a guard.
    const written = /^UPDATE/iu.test(match[0])
      ? statement.split(/\bWHERE\b/iu)[0]
      : statement;
    if (columnWord.test(written)) count += 1;
  }
  return count;
}

const found = {};
for (const machine of machines) {
  const { table, column } = machine.store;
  for (const path of productSources) {
    const file = relative(root, path);
    if (file === machine.owner) continue;
    const count = writesIn(readFileSync(path, "utf8"), table, column);
    if (count === 0) continue;
    found[machine.name] ??= {};
    found[machine.name][file] = count;
  }
}

if (update) {
  writeFileSync(ratchetPath, `${JSON.stringify(found, null, 2)}\n`);
  const total = Object.values(found).reduce(
    (sum, files) => sum + Object.keys(files).length,
    0,
  );
  console.log(`state writers: ratchet holds ${total} writer file(s)`);
  process.exit(0);
}

let ratchet = {};
try {
  ratchet = JSON.parse(readFileSync(ratchetPath, "utf8"));
} catch {
  ratchet = {};
}
const problems = [];
for (const [name, files] of Object.entries(found))
  for (const [file, count] of Object.entries(files)) {
    const allowed = ratchet[name]?.[file] ?? 0;
    if (count > allowed)
      problems.push(
        `${file} writes the state of ${name} ${count} time(s); its owner is the only writer${allowed > 0 ? ` (the ratchet allows ${allowed})` : ""}`,
      );
  }
if (problems.length > 0) {
  console.error(`state writers: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`state writers: ${machines.length} machine(s) checked`);
