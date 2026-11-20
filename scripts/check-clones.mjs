#!/usr/bin/env node
// The clone ratchet (Refactor 17, step A0.8).
//
// jscpd finds blocks of product code that are copies of each other. The
// baseline scripts/jscpd-baseline.json holds one fingerprint for each known
// copy. A fingerprint comes from the tokens of the block, not from its path,
// so a moved file keeps its entry.
//
//   A new copy is refused. Put the shared code in one module and import it.
//   A copy that is gone must leave the baseline, so that it cannot come back.
//
// The scan settings are in .jscpd.json: product code of apps, packages,
// services and crates, without tests, scripts, bundles and generated code.
//
//   node scripts/check-clones.mjs            check
//   node scripts/check-clones.mjs --update   drop the fingerprints that are gone
//   node scripts/check-clones.mjs --init     write the baseline from the tree
//   node scripts/check-clones.mjs --report   print the totals for each folder

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts/jscpd-baseline.json");
const mode = process.argv[2] ?? "check";

if (!["check", "--update", "--init", "--report"].includes(mode)) {
  console.error(`Unknown argument ${mode}.`);
  process.exit(2);
}

const scan = scanTree();

if (mode === "--report") {
  printReport(scan);
  process.exit(0);
}

if (mode === "--init") {
  writeBaseline(scan.fingerprints);
  console.log(
    `Wrote ${count(scan.fingerprints)} copies (${scan.total.duplicatedLines} lines) to scripts/jscpd-baseline.json.`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    "scripts/jscpd-baseline.json is missing. Run node scripts/check-clones.mjs --init.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).fingerprints;
const added = [];
const gone = [];
for (const [fingerprint, current] of Object.entries(scan.fingerprints)) {
  if (current > (baseline[fingerprint] ?? 0)) added.push(fingerprint);
}
for (const [fingerprint, known] of Object.entries(baseline)) {
  if ((scan.fingerprints[fingerprint] ?? 0) < known) gone.push(fingerprint);
}

if (mode === "--update") {
  const next = {};
  for (const [fingerprint, known] of Object.entries(baseline)) {
    const current = Math.min(known, scan.fingerprints[fingerprint] ?? 0);
    if (current > 0) next[fingerprint] = current;
  }
  writeBaseline(next);
  console.log(
    `Dropped ${count(baseline) - count(next)} copies. The baseline holds ${count(next)}.`,
  );
  if (added.length > 0) {
    console.error(
      `${added.length} new copies are not in the baseline. --update does not add a copy.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

let failed = false;
if (added.length > 0) {
  failed = true;
  console.error(`${scan.newClones.length} new copies of product code:`);
  for (const clone of scan.newClones) {
    console.error(
      `  ${clone.firstFile.name}:${clone.firstFile.start}-${clone.firstFile.end}\n    = ${clone.secondFile.name}:${clone.secondFile.start}-${clone.secondFile.end} (${clone.lines} lines)`,
    );
  }
  console.error(
    "Put the shared code in one module and import it from both places. See docs/refactor-17.md, Prune with each step.",
  );
}
if (gone.length > 0) {
  failed = true;
  console.error(
    `${gone.length} copies of the baseline are gone. Run node scripts/check-clones.mjs --update.`,
  );
}
if (failed) process.exit(1);
console.log(
  `${scan.total.clones} known copies (${scan.total.duplicatedLines} lines, ${scan.total.percentage.toFixed(2)} %) in ${scan.total.sources} files. No new copy.`,
);

// One jscpd run. A copy of the baseline receives the fingerprints of the tree,
// and the JSON report marks each copy that the baseline does not hold.
function scanTree() {
  const work = mkdtempSync(join(tmpdir(), "pantry-clones-"));
  try {
    const current = join(work, "current.json");
    const marks = existsSync(baselinePath) && mode !== "--init";
    if (marks) copyFileSync(baselinePath, current);
    const run = spawnSync(
      join(root, "node_modules/.bin/jscpd"),
      [
        "--reporters",
        "json",
        "--output",
        work,
        "--baseline",
        current,
        "--update-baseline",
        "--absolute",
        "--no-tips",
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (run.status !== 0) {
      console.error(run.stdout + run.stderr);
      console.error("jscpd failed. Run pnpm install.");
      process.exit(2);
    }
    const report = JSON.parse(
      readFileSync(join(work, "jscpd-report.json"), "utf8"),
    );
    for (const clone of report.duplicates) {
      clone.firstFile.name = relative(root, clone.firstFile.name);
      clone.secondFile.name = relative(root, clone.secondFile.name);
    }
    return {
      fingerprints: JSON.parse(readFileSync(current, "utf8")).fingerprints,
      total: report.statistics.total,
      duplicates: report.duplicates,
      newClones: report.duplicates.filter((clone) => clone.isNew),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeBaseline(fingerprints) {
  const sorted = Object.fromEntries(
    Object.entries(fingerprints).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ version: 1, fingerprints: sorted }, null, 2)}\n`,
  );
}

function count(fingerprints) {
  return Object.values(fingerprints).reduce((sum, n) => sum + n, 0);
}

function printReport({ total, duplicates }) {
  const folders = new Map();
  for (const clone of duplicates) {
    const folder = clone.firstFile.name.split("/").slice(0, 2).join("/");
    const entry = folders.get(folder) ?? { clones: 0, lines: 0 };
    entry.clones += 1;
    entry.lines += clone.lines;
    folders.set(folder, entry);
  }
  console.log(
    `${total.clones} copies, ${total.duplicatedLines} lines (${total.percentage.toFixed(2)} %) of ${total.lines} lines in ${total.sources} files.`,
  );
  for (const [folder, entry] of [...folders].sort(
    (a, b) => b[1].lines - a[1].lines,
  )) {
    console.log(
      `${String(entry.clones).padStart(5)} copies ${String(entry.lines).padStart(6)} lines  ${folder}`,
    );
  }
}
