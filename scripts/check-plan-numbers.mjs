#!/usr/bin/env node
// Fails when source code names a plan that the spec index does not list
// (Refactor 17, step S1).
//
// A comment such as "Plan 40B phase 7" must lead a reader to a document. The
// table "Old plan numbers" in docs/specs/README.md maps each plan and each
// refactor to its spec, to its plan file, or to the archive. This check reads
// each tracked source file and each form of a mention: "Plan 53", "plan-53",
// "plan53", "Refactor 10". A number that the table lacks is a fault: add a row.
//
//   node scripts/check-plan-numbers.mjs           check
//   node scripts/check-plan-numbers.mjs --list    print each number with its count of mentions
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = "docs/specs/README.md";

const SOURCE =
  /\.(ts|tsx|mjs|js|cjs|rs|py|css|sql|jsonc|toml|sh|html|yml|yaml)$/;
const EXCLUDED = [
  /(^|\/)(node_modules|dist|vendor|generated|public)\//,
  /^scripts\/[^/]+-ratchet\.json$/,
];
// "plan-9" in a path such as tests/plan9-lab is a mention too. A version such
// as "Plan 2026" or "plan-2.1" is not: a plan number has at most three digits,
// and no digit follows its period. A mention at the end of a sentence, such as
// "See Plan 92.", is one. A word such as "floor-plan-2d" is not a mention: no
// letter or hyphen stands before "plan".
const MENTION = /(?<![\w-])(plan|refactor)[ -]?(\d{1,3}[A-Z]?)(?!\w|\.\d)/gi;
// Text that has the form of a mention and is not one. Give each its reason.
const NOT_A_PLAN = new Map([
  [
    "Plan 409",
    "the HTTP status 409 of a costs Plan record, in one journey comment",
  ],
]);

const tracked = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(
    (path) =>
      SOURCE.test(path) &&
      !EXCLUDED.some((pattern) => pattern.test(path)) &&
      existsSync(join(root, path)),
  );

/** "Plan 40B" -> { count, first } */
const mentions = new Map();
for (const path of tracked) {
  const text = readFileSync(join(root, path), "utf8");
  MENTION.lastIndex = 0;
  let match;
  while ((match = MENTION.exec(text)) !== null) {
    const kind = match[1].toLowerCase() === "plan" ? "Plan" : "Refactor";
    const key = `${kind} ${match[2].toUpperCase()}`;
    if (NOT_A_PLAN.has(key)) continue;
    const entry = mentions.get(key) ?? {
      count: 0,
      first: `${path}:${text.slice(0, match.index).split("\n").length}`,
    };
    entry.count += 1;
    mentions.set(key, entry);
  }
}

const sorted = [...mentions].sort(([a], [b]) =>
  a.localeCompare(b, "en", { numeric: true }),
);

if (process.argv[2] === "--list") {
  for (const [key, { count, first }] of sorted) {
    console.log(`${String(count).padStart(5)}  ${key}  ${first}`);
  }
  process.exit(0);
}

const listed = new Set();
for (const line of readFileSync(join(root, INDEX), "utf8").split("\n")) {
  const row = /^\|\s*((?:Plan|Refactor) \d{1,3}[A-Z]?)\s*\|/.exec(line);
  if (row !== null) listed.add(row[1]);
}

const faults = sorted.filter(([key]) => !listed.has(key));
if (faults.length > 0) {
  console.error(
    faults
      .map(
        ([key, { count, first }]) =>
          `${key}: ${count} mentions, first at ${first}`,
      )
      .join("\n"),
  );
  console.error(
    `${faults.length} plan numbers are not in the table "Old plan numbers" of ${INDEX}. Add a row for each.`,
  );
  process.exit(1);
}
console.log(
  `${sorted.length} plan and refactor numbers in ${tracked.length} source files are in ${INDEX}`,
);
