#!/usr/bin/env node
// Fails when a lint or a browser journey names a path that matches no file
// (Refactor 17, step A0.7).
//
// eslint.config.mjs, the check scripts and the ratchet files name source files
// by path. When such a file moves or goes, its rule stops without an error:
// the lint still passes, and the guard is off. This check reads each quoted
// path in those files and fails when it matches no tracked file.
//
// A path may hold `*` and `**`. A path that is absent on purpose (a list of
// deleted files, an output file) goes into ABSENT below, with its reason.
//
// A browser journey loads source files from the Portal dev server. It names
// a file by its path in the repository, through `sourceUrl` in the page
// (/source-url.js of apps/portal/vite.config.ts) and `checkoutUrl` in Node
// (scripts/bakery-robots/simulator-navigation.js), or by its address below
// the Portal folder (`/src/styles.css`). When the file moves, the journey
// fails late, in a browser. This check reads those paths too.
//
//   node scripts/check-lint-paths.mjs
//
// Step A0.6 uses the same reader for the list that a folder move needs:
//
//   node scripts/check-lint-paths.mjs --bound          totals by kind of file
//   node scripts/check-lint-paths.mjs --bound --list   each file with its count
//
// It prints each tracked file, apart from product source and documents, that
// holds the path of another tracked file: a path from the repository root, or
// a `./` or `../` path from its own folder. A move of the named file must
// change that file too. Imports between source files and links in documents
// are not in this list: the type check and `pnpm lint:doc-links` find those.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { targets } from "./lib/layers.mjs";
import { SOURCE_ROOTS } from "./lib/source-roots.mjs";

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
    path === "scripts/layers.json" ||
    path === "scripts/lib/source-roots.mjs",
);

// Paths that are absent on purpose. Give each one its reason.
const ABSENT = new Map([
  ["docs/spec.md", "check-commerce-spec.mjs joins it to services/commerce"],
  // CI checks the merge of dev with main, so the map must know a folder that
  // only main has. Remove the line when dev has the folder.
  ["scripts/brand/", "on main since 2026-11-20, not on dev yet"],
]);

// scripts/layers.json names each module as "<layer>/<module>", and a layer is
// also a root folder since Stage B of Refactor 17. A module name is not a
// path: `foundation/std` is a module whose files are in packages/std.
const MODULE_NAMES = new Set([
  ...["packages", "placement", "tables", "rules", "files"].flatMap((key) =>
    Object.values(targets[key] ?? {}),
  ),
  ...targets.foundationOrder.map((name) => `foundation/${name}`),
]);

const ROOTS = `(?:${[...SOURCE_ROOTS, "crates", "docs", "scripts"].join("|")})`;
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

if (process.argv[2] === "--bound") {
  printBound(process.argv[3] === "--list");
  process.exit(0);
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
    if (ABSENT.has(pattern) || MODULE_NAMES.has(pattern)) continue;
    checked += 1;
    if (!tracked.some(matcher(pattern))) {
      const line = text.slice(0, match.index).split("\n").length;
      faults.push(`${source}:${line}: ${pattern} matches no file`);
    }
  }
}

// The browser journeys. A path with `${...}` is checked up to its last whole
// folder; the large files of repo-binaries.json are in R2 and not in git.
const JOURNEYS = tracked.filter((path) => /^scripts\/.*\.m?js$/.test(path));
const BY_HELPER = /\b(?:sourceUrl|checkoutUrl)\(\s*(["'`])([^"'`]+)\1/g;
const PORTAL_ADDRESS = /(?<![\w.@-])\/src\/[\w./-]+\.(?:tsx?|css)\b/g;
const binaries = JSON.parse(
  readFileSync(join(root, "repo-binaries.json"), "utf8"),
);
const stored = [
  ...Object.keys(binaries.files),
  ...Object.keys(binaries.folders),
];
const isFile = (path) => tracked.some(matcher(path));
// A folder of the list ends with "/".
const inStore = (path) =>
  stored.some(
    (key) => path === key || (key.endsWith("/") && path.startsWith(key)),
  );
let journeyPaths = 0;
const journeyFaults = [];
for (const journey of JOURNEYS) {
  if (journey === "scripts/check-lint-paths.mjs") continue;
  const text = readFileSync(join(root, journey), "utf8");
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  for (const match of text.matchAll(BY_HELPER)) {
    const whole = !match[2].includes("${");
    const path = whole
      ? match[2]
      : match[2].slice(0, match[2].lastIndexOf("/", match[2].indexOf("${")));
    journeyPaths += 1;
    if (!isFile(path) && !inStore(path)) {
      journeyFaults.push(
        `${journey}:${lineOf(match.index)}: ${path} matches no file`,
      );
    }
  }
  for (const match of text.matchAll(PORTAL_ADDRESS)) {
    journeyPaths += 1;
    if (!isFile(`apps/portal${match[0]}`)) {
      journeyFaults.push(
        `${journey}:${lineOf(match.index)}: apps/portal${match[0]} matches no file`,
      );
    }
  }
}

if (faults.length > 0) {
  console.error(faults.join("\n"));
  console.error(
    "A lint path that matches no file turns its rule off. Correct the path, or add it to ABSENT in scripts/check-lint-paths.mjs with its reason.",
  );
}
if (journeyFaults.length > 0) {
  console.error(journeyFaults.join("\n"));
  console.error(
    'A browser journey that names a source file that is gone fails in the browser. Name the file by its path in the repository: sourceUrl("<path>") in the page, checkoutUrl("<path>") in Node.',
  );
}
if (faults.length > 0 || journeyFaults.length > 0) process.exit(1);
console.log(`${checked} lint paths in ${SOURCES.length} files match a file`);
console.log(
  `${journeyPaths} source paths in the browser journeys match a file`,
);

function kindOfBound(path) {
  const name = posix.basename(path);
  if (SOURCES.includes(path)) return "lint and ratchet";
  if (path.startsWith(".github/") || path.startsWith(".githooks/")) return "CI";
  if (name === "package.json" || name === "pnpm-workspace.yaml") {
    return "package manifest";
  }
  if (/^wrangler.*\.jsonc?$/.test(name)) return "Wrangler file";
  if (/^tsconfig.*\.json$/.test(name)) return "tsconfig";
  if (/^(vite|vitest).*\.config\.ts$/.test(name))
    return "Vite and Vitest config";
  if (/^Dockerfile/.test(name) || name === ".dockerignore") return "Dockerfile";
  if (name === "Cargo.toml" || name === "build.rs") return "Cargo";
  if (name === "repo-binaries.json" || name === "journeys.json") return name;
  if (/\.html$/.test(name)) return "HTML page";
  if (path.startsWith("scripts/") || /\/scripts\//.test(path)) return "script";
  if (/\/tests?\//.test(path)) return "test support";
  return "other";
}

function printBound(list) {
  const known = new Set(tracked);
  const folders = new Set();
  for (const path of tracked) {
    for (
      let at = path.indexOf("/");
      at !== -1;
      at = path.indexOf("/", at + 1)
    ) {
      folders.add(path.slice(0, at));
    }
  }
  const exists = (path) => known.has(path) || folders.has(path);
  const candidates = tracked.filter(
    (path) =>
      !/\.(md|rs|png|jpg|jpeg|webp|svg|woff2|wasm|onnx|csv|lock|txt|pdf|glb|ico)$/.test(
        path,
      ) &&
      path !== "pnpm-lock.yaml" &&
      !/^docs\//.test(path) &&
      !/\/(src|public|vendor)\//.test(path) &&
      !/\.test\.tsx?$/.test(path) &&
      !/\.(type-fixtures|types)\.ts$/.test(path),
  );
  const FROM_ROOT = new RegExp(`(?<![\\w./-])(${ROOTS}/[\\w@./*-]+)`, "g");
  const RELATIVE = /(?<![\w/-])(\.\.?\/[\w@./-]+)/g;
  const rows = [];
  for (const path of candidates) {
    const text = readFileSync(join(root, path), "utf8");
    const paths = new Set();
    for (const match of text.matchAll(FROM_ROOT)) {
      const target = match[1].replace(/[/.*]+$/, "").replace(/\/\*.*$/, "");
      if (target !== path && exists(target)) paths.add(target);
    }
    for (const match of text.matchAll(RELATIVE)) {
      const base = posix.normalize(posix.join(posix.dirname(path), match[1]));
      const target = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`].find(
        (candidate) => exists(candidate),
      );
      if (target !== undefined && target !== path && !target.startsWith("..")) {
        paths.add(target);
      }
    }
    // The binary list names files that are in R2 and not in git.
    if (path === "repo-binaries.json") {
      const list = JSON.parse(text);
      for (const key of [
        ...Object.keys(list.files),
        ...Object.keys(list.folders),
      ]) {
        paths.add(key);
      }
    }
    if (paths.size > 0)
      rows.push({ path, kind: kindOfBound(path), count: paths.size });
  }
  const kinds = new Map();
  for (const row of rows) {
    const entry = kinds.get(row.kind) ?? { files: 0, paths: 0 };
    entry.files += 1;
    entry.paths += row.count;
    kinds.set(row.kind, entry);
  }
  console.log("files  paths  kind");
  for (const [kind, entry] of [...kinds].sort(
    (a, b) => b[1].paths - a[1].paths,
  )) {
    console.log(
      `${String(entry.files).padStart(5)} ${String(entry.paths).padStart(6)}  ${kind}`,
    );
  }
  console.log(
    `${rows.length} files hold ${rows.reduce((sum, row) => sum + row.count, 0)} paths of other files.`,
  );
  if (list) {
    for (const row of rows.sort((a, b) =>
      a.kind + a.path < b.kind + b.path ? -1 : 1,
    )) {
      console.log(`${row.kind}\t${row.count}\t${row.path}`);
    }
  }
}
