#!/usr/bin/env node
// Plan 93, 19 November 2026: the first pass over the legacy "satyr" names.
// It changes only names that no deployed Worker, stored row, signed value or
// other repository knows:
//
//   - reserved test hosts (satyr.example, satyr.test, the test Shopify shops),
//   - Slack fixture user ids (U0SATYR),
//   - fixture location ids (satyr_location_1),
//   - the phrases "Satyr Kitchen" and "Satyr Worker",
//   - the word "Satyr" in code comments.
//
// Everything else that says "satyr" is a wire, stored or deployed name. It
// changes with the new stack (Plan 93, step 2).
//
//   node scripts/rename/plan-93-test-names.mjs            # dry run: report only
//   node scripts/rename/plan-93-test-names.mjs --write    # change the tree
//
// Run it from the repository root on a clean tree. A second run changes
// nothing.
import fs from "node:fs";
import { isExcluded, trackedTextFiles } from "./tree.mjs";

const WRITE = process.argv.includes("--write");
const SELF = "scripts/rename/plan-93-test-names.mjs";

/** Paths that keep their text, beside the common exclusions of tree.mjs. */
const EXCLUDED_PATHS = [
  /^scripts\/rename\//,
  // Pinned Kitchen physics bundles: a saved run names its bundle by hash.
  /^apps\/portal\/public\/bakery-physics\//,
  // The names of the files in R2, and the scripts that build those files:
  // a model or a mesh keeps the name that its recorded output has.
  /^repo-binaries\.json$/,
  /^scripts\/bakery-mujoco\//,
  // The text that tells the agent the old names.
  /^services\/platform\/src\/agent-old-names\.ts$/,
  /\.md$/,
];

/** Names that every file kind may hold. Each one exists only in tests and harnesses. */
const VALUE_RULES = [
  // `%2F` comes before the host in a URL-encoded redirect address.
  [/(?<=%2F|\b)satyr\.(example|test)\b/g, "pantry.$1"],
  [/\bsatyr-(test|e2e)\.myshopify\.com\b/g, "pantry-$1.myshopify.com"],
  [/\be2e-satyr\b/g, "e2e-pantry"],
  [/\b(U0(?:BG)?)SATYR\b/g, "$1PANTRY"],
  [/\bsatyr_location_(1|2|other|fixture)\b/g, "pantry_location_$1"],
  [
    /\b(an? |the )?Satyr Kitchen\b/g,
    (_, article) => `${article === "a " ? "a " : (article ?? "")}Kitchen`,
  ],
  [/\bSatyr Worker\b/g, "Pantry Worker"],
];

/** Phrases with "Satyr" that a comment keeps: brand names that the brand rename decides, and the wake phrase. */
const PROTECTED_IN_COMMENTS =
  /Hey Satyr|Satyr (?:Commerce|Vault|Agents)|Satyr-funded|Jev from Satyr|Satyr-Custom/g;

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!!|include|define|if|endif)|--)/;

/** Voice code writes about the spoken word "Satyr": the wake phrase stays until a new wake model passes. */
const SPOKEN_WORD_PATHS = /voice|wake|plan-82/;

function renameCommentWord(line, file) {
  if (SPOKEN_WORD_PATHS.test(file)) return line;
  if (!COMMENT_LINE.test(line) || !/\bSatyr\b/.test(line)) return line;
  const kept = [];
  const masked = line.replace(PROTECTED_IN_COMMENTS, (match) => {
    kept.push(match);
    return `\u0000${kept.length - 1}\u0000`;
  });
  return masked
    .replace(/\bSatyr\b/g, "Pantry")
    .replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)]);
}

function renameText(text, file) {
  let next = text;
  for (const [pattern, replacement] of VALUE_RULES)
    next = next.replace(pattern, replacement);
  return next
    .split("\n")
    .map((line) => renameCommentWord(line, file))
    .join("\n");
}

const changes = [];
for (const file of trackedTextFiles()) {
  if (
    file === SELF ||
    isExcluded(file) ||
    EXCLUDED_PATHS.some((pattern) => pattern.test(file))
  )
    continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("\u0000") || !/satyr/i.test(text)) continue;
  const rewritten = renameText(text, file);
  if (rewritten === text) continue;
  const before = text.split("\n");
  const after = rewritten.split("\n");
  changes.push({
    file,
    text: rewritten,
    lines: before.filter((line, index) => line !== after[index]).length,
  });
}

console.log(
  `Plan 93 test names ${WRITE ? "write" : "dry run"}: ${changes.length} files, ${changes.reduce((sum, change) => sum + change.lines, 0)} lines`,
);
if (WRITE)
  for (const change of changes) fs.writeFileSync(change.file, change.text);
else
  for (const change of changes)
    console.log(`  ${change.lines}\t${change.file}`);
