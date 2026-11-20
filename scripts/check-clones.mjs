#!/usr/bin/env node
// The clone ratchet (Refactor 17, step A0.8).
//
// jscpd finds blocks of product code that are copies of each other. The
// baseline scripts/clones-ratchet.json holds, for each pair of files, the
// count of the copies between them (a file can be a pair with itself).
//
//   A pair may not get one more copy, and a new pair is refused. Put the
//   shared code in one module and import it.
//   When a pair loses a copy, lower its entry with --update, so that the copy
//   cannot come back.
//
// The count of a pair does not change when code near a copy changes or when a
// formatter runs. It changes with the path of a file: after a move, write the
// new path into the baseline.
//
// The scan settings are in .jscpd.json: product code of apps, packages,
// services and crates, without tests, scripts, bundles and generated code.
//
//   node scripts/check-clones.mjs            check
//   node scripts/check-clones.mjs --update   lower entries, drop pairs that are gone
//   node scripts/check-clones.mjs --init     write the baseline from the tree
//   node scripts/check-clones.mjs --report   print the totals for each folder

import { spawnSync } from "node:child_process";
import {
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
const BASELINE = "scripts/clones-ratchet.json";
const baselinePath = join(root, BASELINE);
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
  writeBaseline(scan.pairs);
  console.log(
    `Wrote ${scan.total.clones} copies in ${Object.keys(scan.pairs).length} file pairs to ${BASELINE}.`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `${BASELINE} is missing. Run node scripts/check-clones.mjs --init.`,
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).pairs;
const grown = Object.entries(scan.pairs).filter(
  ([pair, count]) => count > (baseline[pair] ?? 0),
);
const lower = Object.entries(baseline).filter(
  ([pair, count]) => (scan.pairs[pair] ?? 0) < count,
);

if (mode === "--update") {
  if (grown.length > 0) {
    reportGrown();
    console.error("A pair grew, so the baseline is not changed.");
    process.exit(1);
  }
  writeBaseline(scan.pairs);
  console.log(
    `Lowered ${lower.length} pairs. The baseline holds ${scan.total.clones} copies.`,
  );
  process.exit(0);
}

let failed = false;
if (grown.length > 0) {
  failed = true;
  reportGrown();
  console.error(
    "Put the shared code in one module and import it from both places. See docs/refactor-17.md, Prune with each step.",
  );
}
if (lower.length > 0) {
  failed = true;
  console.error(
    `${lower.length} file pairs have fewer copies than the baseline. Run node scripts/check-clones.mjs --update.`,
  );
}
if (failed) process.exit(1);
console.log(
  `${scan.total.clones} known copies (${scan.total.duplicatedLines} lines, ${scan.total.percentage.toFixed(2)} %) in ${scan.total.sources} files. No new copy.`,
);

function reportGrown() {
  for (const [pair, count] of grown) {
    console.error(
      `${pair}: ${count} copies, the baseline allows ${baseline[pair] ?? 0}.`,
    );
    for (const clone of scan.duplicates.filter(
      (candidate) => pairOf(candidate) === pair,
    )) {
      console.error(
        `  ${clone.firstFile.name}:${clone.firstFile.start}-${clone.firstFile.end} = ${clone.secondFile.name}:${clone.secondFile.start}-${clone.secondFile.end} (${clone.lines} lines)`,
      );
    }
  }
}

function pairOf(clone) {
  return [clone.firstFile.name, clone.secondFile.name].sort().join(" = ");
}

// One jscpd run with the JSON report.
function scanTree() {
  const work = mkdtempSync(join(tmpdir(), "pantry-clones-"));
  try {
    const run = spawnSync(
      join(root, "node_modules/.bin/jscpd"),
      ["--reporters", "json", "--output", work, "--absolute", "--no-tips"],
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
    const pairs = {};
    for (const clone of report.duplicates) {
      clone.firstFile.name = relative(root, clone.firstFile.name);
      clone.secondFile.name = relative(root, clone.secondFile.name);
      const pair = pairOf(clone);
      pairs[pair] = (pairs[pair] ?? 0) + 1;
    }
    return {
      pairs,
      total: report.statistics.total,
      duplicates: report.duplicates,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeBaseline(pairs) {
  const sorted = Object.fromEntries(
    Object.entries(pairs).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ pairs: sorted }, null, 2)}\n`,
  );
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
