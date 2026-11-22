#!/usr/bin/env node
// The clone ratchet (Refactor 17, step A0.8).
//
// jscpd finds blocks of product code that are copies of each other. The
// baseline scripts/clones-ratchet.json holds, for each pair of files, the
// count of the copies between them and their copied lines (a file can be a
// pair with itself), and the totals of the tree.
//
//   A pair may not get one more copy or one more copied line, and a new pair
//   is refused. Put the shared code in one module and import it.
//   When a pair loses a copy or a line, lower its entry with --update, so
//   that the copy cannot come back.
//
// jscpd reports a copy in three files as pairs of the first file with each
// other file. When the first file loses its copy, jscpd reports a new pair
// of the other two. Such a new pair passes, and --update records it, when
// both of its files are in the baseline and the totals of copies and copied
// lines do not grow.
//
// A copy that grows near its edges adds lines, so the check fails. A
// formatter can change the line count of a copy: lower the entry with
// --update when it falls. After a move, write the new path into the
// baseline. The baseline holds counts only; the reason to keep a copy is in
// docs/refactor-17.md.
//
// The scan settings are in .jscpd.json: product code of apps, packages,
// services and crates, without tests, scripts, bundles and generated code.
//
//   node scripts/check-clones.mjs            check
//   node scripts/check-clones.mjs --update   lower entries, drop pairs that are gone, record moved pairs
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

import { clonePairKey, clonesBaselineText } from "./lib/clones-ratchet.mjs";

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
    `Wrote ${scan.total.clones} copies (${scan.total.duplicatedLines} lines) in ${Object.keys(scan.pairs).length} file pairs to ${BASELINE}.`,
  );
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(
    `${BASELINE} is missing. Run node scripts/check-clones.mjs --init.`,
  );
  process.exit(1);
}

const baselineFile = JSON.parse(readFileSync(baselinePath, "utf8"));
const baseline = baselineFile.pairs;
const baselineTotal = baselineFile.total;
if (
  baselineTotal === undefined ||
  Object.values(baseline).some((entry) => typeof entry !== "object")
) {
  console.error(
    `${BASELINE} has the old form (copies only). Run node scripts/check-clones.mjs --init.`,
  );
  process.exit(1);
}
const knownFiles = new Set(
  Object.keys(baseline).flatMap((pair) => pair.split(" = ")),
);
const totalsHold =
  scan.total.clones <= baselineTotal.copies &&
  scan.total.duplicatedLines <= baselineTotal.lines;
// A new pair of two known files, while the totals do not grow, is a copy
// that jscpd now reports between other files of the same group.
const moved = Object.keys(scan.pairs).filter(
  (pair) =>
    baseline[pair] === undefined &&
    totalsHold &&
    pair.split(" = ").every((file) => knownFiles.has(file)),
);
const grown = Object.entries(scan.pairs).filter(([pair, entry]) => {
  if (moved.includes(pair)) return false;
  const known = baseline[pair];
  return (
    known === undefined ||
    entry.copies > known.copies ||
    entry.lines > known.lines
  );
});
const lower = Object.entries(baseline).filter(([pair, known]) => {
  const entry = scan.pairs[pair];
  return (
    entry === undefined ||
    entry.copies < known.copies ||
    entry.lines < known.lines
  );
});

if (mode === "--update") {
  if (grown.length > 0) {
    reportGrown();
    console.error("A pair grew, so the baseline is not changed.");
    process.exit(1);
  }
  writeBaseline(scan.pairs);
  console.log(
    `Lowered ${lower.length} pairs and recorded ${moved.length} moved pairs. The baseline holds ${scan.total.clones} copies (${scan.total.duplicatedLines} lines).`,
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
if (lower.length > 0 || moved.length > 0) {
  failed = true;
  console.error(
    `${lower.length} file pairs have fewer copies or lines than the baseline, and ${moved.length} pairs moved. Run node scripts/check-clones.mjs --update.`,
  );
}
if (failed) process.exit(1);
console.log(
  `${scan.total.clones} known copies (${scan.total.duplicatedLines} lines, ${scan.total.percentage.toFixed(2)} %) in ${scan.total.sources} files. No new copy and no new copied line.`,
);

function reportGrown() {
  for (const [pair, entry] of grown) {
    const known = baseline[pair];
    console.error(
      `${pair}: ${entry.copies} copies of ${entry.lines} lines, the baseline allows ${known?.copies ?? 0} copies of ${known?.lines ?? 0} lines.`,
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
  return clonePairKey(clone.firstFile.name, clone.secondFile.name);
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
      const entry = pairs[pair] ?? { copies: 0, lines: 0 };
      pairs[pair] = { copies: entry.copies + 1, lines: entry.lines + clone.lines };
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
  const total = {
    copies: scan.total.clones,
    lines: scan.total.duplicatedLines,
  };
  writeFileSync(baselinePath, clonesBaselineText(total, pairs));
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
