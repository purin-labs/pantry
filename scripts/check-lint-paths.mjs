#!/usr/bin/env node
// Fails when a lint names a path that matches no file (Refactor 17, step A0.7).
//
// eslint.config.mjs, the check scripts and the ratchet files name source files
// by path. When such a file moves or goes, its rule stops without an error:
// the lint still passes, and the guard is off. This check reads each quoted
// path in those files and fails when it matches no tracked file.
//
// A path may hold `*` and `**`. A path that is absent on purpose (a list of
// deleted files, an output file) goes into ABSENT below, with its reason.
//
//   node scripts/check-lint-paths.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const tracked = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((path) => path !== "");

// The files that hold paths of other files.
const SOURCES = tracked.filter(
  (path) =>
    path === "eslint.config.mjs" ||
    /^scripts\/check-[^/]+\.mjs$/.test(path) ||
    /^scripts\/[^/]+-ratchet\.json$/.test(path) ||
    path === "scripts/layers.json",
);

// Paths that are absent on purpose. Give each one its reason.
const ABSENT = new Map([
  ["docs/spec.md", "check-commerce-spec.mjs joins it to services/commerce"],
]);

const ROOTS = "(?:apps|crates|docs|packages|scripts|services)";
const QUOTED = new RegExp(`["'\`](${ROOTS}/[^"'\`\\s$\\\\]+)["'\`]`, "g");

function matcher(pattern) {
  if (!/[*?{]/.test(pattern)) {
    const folder = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return (path) => path === pattern || path.startsWith(folder);
  }
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += pattern[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}$`);
  return (path) => regex.test(path);
}

const faults = [];
let checked = 0;
for (const source of SOURCES) {
  const text = readFileSync(join(root, source), "utf8");
  const seen = new Set();
  QUOTED.lastIndex = 0;
  let match;
  while ((match = QUOTED.exec(text)) !== null) {
    // "path#name" names one declaration of a file: check the file.
    const pattern = match[1].replace(/#.*$/, "");
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    if (ABSENT.has(pattern)) continue;
    checked += 1;
    if (!tracked.some(matcher(pattern))) {
      const line = text.slice(0, match.index).split("\n").length;
      faults.push(`${source}:${line}: ${pattern} matches no file`);
    }
  }
}

if (faults.length > 0) {
  console.error(faults.join("\n"));
  console.error(
    "A lint path that matches no file turns its rule off. Correct the path, or add it to ABSENT in scripts/check-lint-paths.mjs with its reason.",
  );
  process.exit(1);
}
console.log(`${checked} lint paths in ${SOURCES.length} files match a file`);
