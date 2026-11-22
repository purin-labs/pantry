#!/usr/bin/env node
// The unused-code ratchet (Refactor 17, step A0.8).
//
// knip reads the import graph from the entry files in knip.json. It reports a
// file that no entry reaches, and an export that no other file imports. The
// baseline scripts/unused-ratchet.json holds the known ones.
//
//   A new unused file is refused. Delete it, or import it.
//   A new unused export is refused. Remove the `export`, or delete the code.
//   An entry that is gone must leave the baseline, so that it cannot come back.
//
// knip is wrong for a file that only a tool starts: a new Worker, a new page
// with its own HTML file, a new config. Add that file to the entry list of its
// workspace in knip.json. Do not add it to the baseline.
//
// knip does not judge a file that a generator writes, such as
// services/platform/src/generated/ (scripts/generate-actions.ts): the
// generator decides its exports, and a hand edit is lost at the next run. Its
// folder is in the ignore list of its workspace in knip.json.
//
// knip does not judge the exports of an entry file. Each file in the
// `exports` map of a workspace package is such an entry, so an export there
// with no importer is not in the list above. The baseline holds their count,
// `packageEntryExports`, from a second run with --include-entry-exports. The
// count may not grow: before you add an export to a package entry, import it
// somewhere. When it falls, lower it with --update.
//
// An export that something outside the import graph reads at run time, such
// as a browser check script or a lint that reads the source text, carries a
// `@public` tag in its doc comment, with the reader.
//
//   node scripts/check-unused.mjs            check
//   node scripts/check-unused.mjs --update   drop the entries that are gone
//   node scripts/check-unused.mjs --init     write the baseline from the tree
//   node scripts/check-unused.mjs --report   print the totals for each folder

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import { SOURCE_ROOTS } from "./lib/source-roots.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts/unused-ratchet.json");
const mode = process.argv[2] ?? "check";

if (!["check", "--update", "--init", "--report"].includes(mode)) {
  console.error(`Unknown argument ${mode}.`);
  process.exit(2);
}

const current = scanTree();

if (mode === "--report") {
  printReport(current);
  process.exit(0);
}

if (mode === "--init") {
  await writeBaseline(current);
  console.log(
    `Wrote ${current.files.length} unused files, ${current.exports.length} unused exports and ${current.packageEntryExports} package entry exports with no importer to scripts/unused-ratchet.json.`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    "scripts/unused-ratchet.json is missing. Run node scripts/check-unused.mjs --init.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const added = {
  files: without(current.files, baseline.files),
  exports: without(current.exports, baseline.exports),
};
const gone = {
  files: without(baseline.files, current.files),
  exports: without(baseline.exports, current.exports),
};
const entryGrown =
  current.packageEntryExports > (baseline.packageEntryExports ?? 0);
const entryFell =
  current.packageEntryExports < (baseline.packageEntryExports ?? 0);
const addedCount = added.files.length + added.exports.length;
const goneCount = gone.files.length + gone.exports.length;

if (mode === "--update") {
  const next = {
    files: without(baseline.files, gone.files),
    exports: without(baseline.exports, gone.exports),
    packageEntryExports: Math.min(
      current.packageEntryExports,
      baseline.packageEntryExports ?? current.packageEntryExports,
    ),
  };
  await writeBaseline(next);
  console.log(
    `Dropped ${goneCount} entries. The baseline holds ${next.files.length} unused files, ${next.exports.length} unused exports and ${next.packageEntryExports} package entry exports with no importer.`,
  );
  if (entryGrown) {
    console.error(
      `${current.packageEntryExports} package entry exports have no importer; the baseline allows ${baseline.packageEntryExports ?? 0}. --update does not raise it.`,
    );
    process.exit(1);
  }
  if (addedCount > 0) {
    console.error(
      `${addedCount} new entries are not in the baseline. --update does not add an entry.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

let failed = false;
if (added.files.length > 0) {
  failed = true;
  console.error(`${added.files.length} new files that no entry file reaches:`);
  for (const file of added.files) console.error(`  ${file}`);
  console.error(
    "Delete the file or import it. If a tool starts the file, add it to the entry list of its workspace in knip.json.",
  );
}
if (added.exports.length > 0) {
  failed = true;
  console.error(
    `${added.exports.length} new exports that no other file imports:`,
  );
  for (const entry of added.exports) console.error(`  ${entry}`);
  console.error(
    "Remove the `export`, or delete the code if nothing in its file uses it.",
  );
}
if (entryGrown) {
  failed = true;
  console.error(
    `${current.packageEntryExports} exports of package entry files have no importer; the baseline allows ${baseline.packageEntryExports ?? 0}. Import the new export where it is used, or remove the \`export\`. node scripts/check-unused.mjs --report lists them.`,
  );
}
if (goneCount > 0 || entryFell) {
  failed = true;
  console.error(
    `${goneCount} entries of the baseline are gone${entryFell ? ", and the count of package entry exports with no importer fell" : ""}. Run node scripts/check-unused.mjs --update.`,
  );
}
if (failed) process.exit(1);
console.log(
  `${current.files.length} known unused files, ${current.exports.length} known unused exports and ${current.packageEntryExports} package entry exports with no importer. No new one.`,
);

// An export entry is "<file>#<name>". A value and a type of one name in one
// file are one entry.
function scanTree() {
  const files = new Set();
  const exports = new Set();
  for (const issue of runKnip([])) {
    if (issue.files?.length > 0) files.add(issue.file);
    for (const entry of exportEntries(issue)) exports.add(entry);
  }
  const entryFiles = packageEntryFiles();
  const entryExports = new Set();
  for (const issue of runKnip(["--include-entry-exports"])) {
    if (!entryFiles.has(issue.file)) continue;
    for (const entry of exportEntries(issue)) entryExports.add(entry);
  }
  return {
    files: [...files].sort(),
    exports: [...exports].sort(),
    packageEntryExports: entryExports.size,
    entryExports: [...entryExports].sort(),
  };
}

function runKnip(extra) {
  const run = spawnSync(
    join(root, "node_modules/.bin/knip"),
    [
      "--no-progress",
      "--no-config-hints",
      "--no-exit-code",
      "--reporter",
      "json",
      ...extra,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0 || !run.stdout.trimStart().startsWith("{")) {
    console.error(run.stdout + run.stderr);
    console.error("knip failed. Run pnpm install, then read knip.json.");
    process.exit(2);
  }
  return JSON.parse(run.stdout).issues;
}

function exportEntries(issue) {
  const entries = [];
  for (const kind of ["exports", "types"]) {
    for (const item of issue[kind] ?? []) {
      entries.push(`${issue.file}#${item.name}`);
    }
  }
  return entries;
}

// The source files that the `exports` map of each workspace package names.
// A target with `*` names each file of its folder that matches.
function packageEntryFiles() {
  const entries = new Set();
  for (const folder of SOURCE_ROOTS) {
    const base = join(root, folder);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const manifestPath = join(base, name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const target of exportTargets(manifest.exports)) {
        for (const file of expandTarget(join(base, name), target)) {
          entries.add(relative(root, file));
        }
      }
    }
  }
  return entries;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function expandTarget(packageFolder, target) {
  if (!/\.(m?[jt]sx?)$/u.test(target)) return [];
  const path = join(packageFolder, target);
  if (!path.includes("*")) return existsSync(path) ? [path] : [];
  const [prefix, suffix] = path.split("*");
  const folder = dirname(prefix);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return [];
  return readdirSync(folder)
    .map((file) => join(folder, file))
    .filter(
      (file) =>
        file.startsWith(prefix) &&
        file.endsWith(suffix) &&
        !file.slice(prefix.length, file.length - suffix.length).includes("/"),
    );
}

function without(list, removed) {
  const set = new Set(removed);
  return list.filter((entry) => !set.has(entry));
}

async function writeBaseline({ files, exports, packageEntryExports }) {
  const text = JSON.stringify({ packageEntryExports, files, exports });
  writeFileSync(baselinePath, await format(text, { parser: "json" }));
}

function printReport({ files, exports, entryExports }) {
  const folders = new Map();
  for (const entry of exports) {
    const folder = entry.split("/").slice(0, 2).join("/");
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  console.log(
    `${files.length} unused files, ${exports.length} unused exports.`,
  );
  for (const file of files) console.log(`  file ${file}`);
  for (const [folder, n] of [...folders].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(5)} exports  ${folder}`);
  }
  console.log(
    `${entryExports.length} exports of package entry files have no importer:`,
  );
  for (const entry of entryExports) console.log(`  ${entry}`);
}
