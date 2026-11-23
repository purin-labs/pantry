#!/usr/bin/env node
// Fails when a change to a deployed D1 baseline ships without a patch.
//
// The baselines services/platform/migrations-global/0001_current_schema.sql and
// migrations-regional/0001_current_schema.sql are edited in place, and a
// deployed database never reads them again. A person applies a patch script
// to each database by hand. This check compares each baseline with its copy at
// the base revision. Every table, index or trigger that the change adds,
// removes or alters must be named in a patch script that the change adds
// (services/platform/scripts/*d1*.sql), or in the waiver file
// services/platform/scripts/d1-patch-waivers.txt (one `object: reason` per
// line) when no deployed database needs a patch.
//
//   node scripts/check-d1-patch.mjs [--base <revision>]
//
// The base is the upstream of the current branch. CI passes the base of the
// pull request.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { snapshotOfBaseline } from "./d1-schema-snapshot.mjs";
import { formerPath } from "./refactor-17/folder-renames.mjs";

const root = resolve(import.meta.dirname, "..");
const BASELINES = [
  "services/platform/migrations-global/0001_current_schema.sql",
  "services/platform/migrations-regional/0001_current_schema.sql",
];
const PATCH_DIRECTORY = "services/platform/scripts";
const WAIVERS = `${PATCH_DIRECTORY}/d1-patch-waivers.txt`;

const baseIndex = process.argv.indexOf("--base");
const base =
  baseIndex === -1
    ? git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      )
    : process.argv[baseIndex + 1];
if (!base)
  throw new Error(
    "No base revision: the branch has no upstream. Pass --base <revision>.",
  );

const changes = [];
for (const path of BASELINES) {
  // A base from before the rename of the Worker folder holds the baseline
  // at its old path (scripts/refactor-17/folder-renames.mjs).
  const before =
    git(["show", `${base}:${path}`], true) ??
    git(["show", `${base}:${formerPath(path)}`], true);
  const after = readFileSync(resolve(root, path), "utf8");
  if (before === null || before === after) continue;
  const oldSnapshot = snapshotOfBaseline(before);
  const newSnapshot = snapshotOfBaseline(after);
  for (const [name, object] of newSnapshot) {
    const old = oldSnapshot.get(name);
    if (old === undefined)
      changes.push({ path, name, what: `adds ${object.type}` });
    else if (differs(old, object))
      changes.push({ path, name, what: `alters ${object.type}` });
  }
  for (const [name, object] of oldSnapshot) {
    if (!newSnapshot.has(name))
      changes.push({ path, name, what: `removes ${object.type}` });
  }
}

if (changes.length === 0) {
  console.log(`ok      no baseline change since ${base}`);
} else {
  const patches = patchFiles();
  const patchText = patches
    .map((file) => readFileSync(resolve(root, file), "utf8"))
    .join("\n");
  const waived = readWaivers();
  const uncovered = changes.filter(
    ({ name }) =>
      !waived.has(name) &&
      !new RegExp(`\\b${escape(name)}\\b`, "u").test(patchText),
  );
  if (uncovered.length === 0) {
    console.log(
      `ok      ${changes.length} baseline change(s) since ${base} are named in ${patches.length} patch script(s) or waived`,
    );
  } else {
    console.error(
      `PATCH   ${uncovered.length} baseline change(s) since ${base} have no patch:`,
    );
    for (const { path, name, what } of uncovered)
      console.error(`  ${what} ${name}  (${path})`);
    console.error(
      `\nAdd a patch script ${PATCH_DIRECTORY}/<plan>-d1-patch.sql that names each object above, so that a deployed regional database can take the change. If no deployed database needs a patch, list the object in ${WAIVERS} as "<object>: <reason>".`,
    );
    process.exitCode = 1;
  }
}

function differs(old, object) {
  if (old.type !== object.type || old.sql !== object.sql) return true;
  if (old.columns.size !== object.columns.size) return true;
  for (const [column, definition] of object.columns) {
    if (old.columns.get(column) !== definition) return true;
  }
  return false;
}

/** Patch scripts that the change adds: committed since the base, or new on disk. */
function patchFiles() {
  const added = git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    base,
    "--",
    PATCH_DIRECTORY,
  ]);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    PATCH_DIRECTORY,
  ]);
  return [...new Set([...lines(added), ...lines(untracked)])].filter((file) =>
    /d1.*\.sql$/u.test(file),
  );
}

function readWaivers() {
  const waived = new Set();
  if (!existsSync(resolve(root, WAIVERS))) return waived;
  for (const line of readFileSync(resolve(root, WAIVERS), "utf8").split("\n")) {
    const match = /^([A-Za-z0-9_]+):\s*\S/u.exec(line);
    if (match) waived.add(match[1]);
  }
  return waived;
}

function lines(text) {
  return (text ?? "").split("\n").filter((line) => line.length > 0);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function git(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
