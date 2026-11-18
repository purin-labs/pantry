#!/usr/bin/env node
// Fails when a large source file grows (Refactor 10, step 0A).
//
// A source file over LIMIT lines may not grow, and a new file may not pass
// LIMIT. The baseline in scripts/file-size-ratchet.json lists each file over
// LIMIT with its line count. Put new code in a new module beside the file
// instead. When a listed file gets smaller, lower its entry with --update, so
// that the file cannot grow back.
//
//   node scripts/check-file-size-ratchet.mjs            check
//   node scripts/check-file-size-ratchet.mjs --update   lower entries, drop small or deleted files
//   node scripts/check-file-size-ratchet.mjs --init     write the baseline from the current tree
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/file-size-ratchet.json";
const LIMIT = 3000;

// Source code only: tests, generated files and data tables are not checked.
// Since Refactor 16 step 14 the ratchet also covers the Rust crates and the
// scripts (journeys, builders and tools).
const SOURCE = [
  /^(apps|packages|services)\/.+\.(ts|tsx|mjs|js)$/,
  /^crates\/.+\.rs$/,
  /^scripts\/.+\.(mjs|js|py)$/,
];
const EXCLUDED = [
  /(^|\/)(tests?|bindings|generated|dist|public|vendor|node_modules)\//,
  /\.test\.[a-z]+$/,
  /\.generated\.[a-z]+$/,
  /^packages\/commerce-contracts\/src\/unicode-tables\.ts$/,
];

const mode = process.argv[2] ?? "check";
if (!["check", "--update", "--init"].includes(mode)) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}

function lineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const current = new Map();
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(
    (file) =>
      SOURCE.some((pattern) => pattern.test(file)) &&
      !EXCLUDED.some((pattern) => pattern.test(file)),
  );
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  const lines = lineCount(text);
  if (lines > LIMIT) current.set(file, lines);
}

function write(entries) {
  const sorted = Object.fromEntries(
    [...entries].sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify({ limit: LIMIT, files: sorted }, null, 2)}\n`,
  );
}

if (mode === "--init") {
  write(current);
  console.log(
    `file size ratchet: wrote ${current.size} files over ${LIMIT} lines to ${BASELINE}`,
  );
  process.exit(0);
}

const baseline = new Map(
  Object.entries(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).files),
);

const errors = [];
const lower = [];
for (const [file, lines] of current) {
  const allowed = baseline.get(file);
  if (allowed === undefined)
    errors.push(
      `${file} has ${lines} lines, over the limit of ${LIMIT}. Split it into modules of less than ${LIMIT} lines.`,
    );
  else if (lines > allowed)
    errors.push(
      `${file} grew from ${allowed} to ${lines} lines. Put the new code in a new module beside it (docs/refactor-10.md).`,
    );
  else if (lines < allowed) lower.push(file);
}
for (const file of baseline.keys()) if (!current.has(file)) lower.push(file);

if (mode === "--update") {
  const next = new Map();
  for (const [file, allowed] of baseline) {
    const lines = current.get(file);
    if (lines !== undefined) next.set(file, Math.min(allowed, lines));
  }
  write(next);
  console.log(`file size ratchet: lowered or removed ${lower.length} entries`);
}

for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
if (mode === "check" && lower.length > 0)
  console.log(
    `file size ratchet: ${lower.length} files got smaller; run node scripts/check-file-size-ratchet.mjs --update to lower the baseline`,
  );
console.log(
  `file size ratchet: ${current.size} files over ${LIMIT} lines, none grew`,
);
