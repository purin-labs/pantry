#!/usr/bin/env node
// Moves accepted plans to docs/history/ (Refactor 17, step S2). A plan moves
// unchanged: only the targets of its relative links change, so that each link
// names the same file from the new folder. Each link in another tracked
// Markdown file that names a moved plan gets its new path too. A link that
// was broken before stays broken, and its entry in
// scripts/doc-links-ratchet.json follows it.
//
//   node scripts/move-plan-to-history.mjs docs/plan-85-device-fleet-page.md [...]
//
// Run `pnpm lint:doc-links` after it.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY = "docs/history";
const RATCHET = "scripts/doc-links-ratchet.json";
const LINK = /\]\(([^)\s]+)(\s+"[^"]*")?\)/g;

const sources = process.argv.slice(2);
if (sources.length === 0) {
  console.error("Name one or more plans, for example docs/plan-85-device-fleet-page.md");
  process.exit(2);
}
const moves = new Map();
for (const source of sources) {
  const from = posix.normalize(source);
  if (!from.startsWith("docs/") || from.startsWith(`${HISTORY}/`))
    throw new Error(`${from}: only a document under docs/ moves to ${HISTORY}/`);
  if (!existsSync(join(root, from))) throw new Error(`${from} does not exist`);
  moves.set(from, `${HISTORY}/${posix.basename(from)}`);
}

const pages = execFileSync("git", ["ls-files", "--", "*.md"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((path) => path !== "" && !path.startsWith("vendor/"));

function isRelative(target) {
  return !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/|\/)/i.test(target);
}

function splitTarget(target) {
  const at = target.search(/[#?]/);
  return at < 0 ? [target, ""] : [target.slice(0, at), target.slice(at)];
}

/** The link target that names `file` from a page at `page`. */
function linkFrom(page, file) {
  return posix.relative(posix.dirname(page), file);
}

/** Rewrites the relative links of one page; returns the new text and the changes. */
function rewrite(text, oldPage, newPage) {
  const changes = [];
  let fenced = false;
  const lines = text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const spans = [...line.matchAll(/`[^`]*`/g)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    const inSpan = (index) => spans.some(([a, b]) => index >= a && index < b);
    return line.replace(LINK, (whole, target, title = "", offset) => {
      if (inSpan(offset) || !isRelative(target)) return whole;
      const [path, rest] = splitTarget(target);
      if (path === "") return whole;
      const named = posix.normalize(
        posix.join(posix.dirname(oldPage), decodeURIComponent(path)),
      );
      const file = moves.get(named) ?? named;
      if (file === named && newPage === oldPage) return whole;
      const next = `${linkFrom(newPage, file)}${rest}`;
      if (next === target) return whole;
      changes.push([target, next]);
      return `](${next}${title})`;
    });
  });
  return { text: lines.join("\n"), changes };
}

const ratchet = JSON.parse(readFileSync(join(root, RATCHET), "utf8"));
const ratchetNext = {};
const renamed = [];
const pageMoves = new Map(moves);
for (const page of pages) {
  const newPage = pageMoves.get(page) ?? page;
  const text = readFileSync(join(root, page), "utf8");
  const { text: next, changes } = rewrite(text, page, newPage);
  if (changes.length > 0) writeFileSync(join(root, page), next);
  const byTarget = new Map(changes);
  for (const [key, count] of Object.entries(ratchet)) {
    const [keyPage, keyTarget] = key.split(" -> ");
    if (keyPage !== page) continue;
    const target = byTarget.get(keyTarget) ?? keyTarget;
    ratchetNext[`${newPage} -> ${target}`] = count;
  }
  if (changes.length > 0) renamed.push(`${page}: ${changes.length} links`);
}
for (const [key, count] of Object.entries(ratchet)) {
  const [keyPage] = key.split(" -> ");
  if (!pages.includes(keyPage)) ratchetNext[key] = count;
}
writeFileSync(
  join(root, RATCHET),
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(ratchetNext).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    null,
    2,
  )}\n`,
);

mkdirSync(join(root, HISTORY), { recursive: true });
for (const [from, to] of moves) {
  execFileSync("git", ["mv", from, to], { cwd: root });
  console.log(`moved ${from} -> ${to}`);
}
for (const line of renamed) console.log(`links: ${line}`);
