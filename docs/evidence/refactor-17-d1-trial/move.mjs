#!/usr/bin/env node
// Trial move script (Refactor 17, decision D1). Moves files and rewrites the
// import specifiers that the move changes.
//
//   node move.mjs <repo root> <plan.json> [--dry]
//
// plan.json:
//   { "moves": { "<old repo path>": "<new repo path>" },
//     "packages": [ { "root": "foundation/kernel", "name": "@purin-labs/kernel", "src": "" } ],
//     "worker": { "root": "services/platform", "name": "@purin-labs/platform" } }
//
// With no "packages", each changed specifier stays relative (variant F).
// With "packages", an import that crosses a package root goes by name
// (variant P): `<name>/<path inside the package, no extension>`.
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

const [root, planPath, ...flags] = process.argv.slice(2);
const dry = flags.includes("--dry");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const moves = plan.moves;
const packages = plan.packages ?? [];
const worker = plan.worker ?? null;

const tracked = execSync("git ls-files", { cwd: root, maxBuffer: 1 << 30 })
  .toString()
  .trim()
  .split("\n");
const sources = tracked.filter(
  (f) =>
    /\.(ts|tsx|mts|cts|mjs|js|jsx)$/.test(f) &&
    !f.includes("/vendor/") &&
    !f.startsWith("apps/portal/public/") &&
    existsSync(join(root, f)),
);

const isFile = (p) => {
  try {
    return statSync(join(root, p)).isFile();
  } catch {
    return false;
  }
};

/** The old tree file that a relative specifier names, and how it was written. */
function resolveOld(from, spec) {
  const [bare, query = ""] = spec.split(/(?=\?)/u);
  const base = posix.normalize(posix.join(dirname(from), bare));
  if (isFile(base)) return { file: base, style: "exact", query };
  for (const ext of [".ts", ".tsx", ".mts", ".mjs", ".js", ".d.ts"]) {
    if (isFile(base + ext)) return { file: base + ext, style: "bare", query };
  }
  if (/\.js$/u.test(base)) {
    for (const ext of [".ts", ".tsx"]) {
      const candidate = base.replace(/\.js$/u, ext);
      if (isFile(candidate)) return { file: candidate, style: "js", query };
    }
  }
  for (const index of ["/index.ts", "/index.tsx", "/index.mjs", "/index.js"]) {
    if (isFile(base + index))
      return { file: base + index, style: "dir", query };
  }
  return null;
}

const packageOf = (path) =>
  packages.find((p) => path.startsWith(p.root + "/")) ?? null;

function newSpecifier(fromNew, target) {
  const targetNew = moves[target.file] ?? target.file;
  const toPackage = packageOf(targetNew);
  const fromPackage = packageOf(fromNew);
  const strip = (p) =>
    target.style === "bare"
      ? p.replace(/\.(d\.ts|ts|tsx|mts|mjs|js)$/u, "")
      : target.style === "js"
        ? p.replace(/\.tsx?$/u, ".js")
        : target.style === "dir"
          ? p.replace(/\/index\.(ts|tsx|mjs|js)$/u, "")
          : p;
  if (
    toPackage &&
    toPackage !== fromPackage &&
    !fromNew.startsWith("scripts/")
  ) {
    const inside = targetNew.slice(toPackage.root.length + 1);
    return {
      spec: `${toPackage.name}/${strip(inside)}${target.query}`,
      by: "name",
    };
  }
  if (
    fromPackage &&
    !toPackage &&
    worker &&
    targetNew.startsWith(worker.root + "/")
  ) {
    const inside = targetNew.slice(worker.root.length + 1);
    return {
      spec: `${worker.name}/${strip(inside)}${target.query}`,
      by: "worker",
    };
  }
  let rel = posix.relative(dirname(fromNew), strip(targetNew));
  if (!rel.startsWith(".")) rel = "./" + rel;
  return { spec: rel + target.query, by: "relative" };
}

// A specifier in: import/export ... from "x", import "x", import("x"),
// declare module "x", require("x"), vi.mock("x"), vi.doMock, vi.importActual,
// new URL("x", import.meta.url), import.meta.glob("x").
const patterns = [
  /(\bfrom\s*)(["'])(\.{1,2}\/[^"']*)\2/gu,
  /(\bimport\s*)(["'])(\.{1,2}\/[^"']*)\2/gu,
  /(\bimport\(\s*)(["'])(\.{1,2}\/[^"']*)\2/gu,
  /(\bdeclare\s+module\s+)(["'])(\.{1,2}\/[^"']*)\2/gu,
  /(\brequire\(\s*)(["'])(\.{1,2}\/[^"']*)\2/gu,
  /(\bvi\.(?:mock|doMock|importActual|unmock)\(\s*)(["'])(\.{1,2}\/[^"']*)\2/gu,
  /(\bnew\s+(?:Node)?U(?:RL|rl)\(\s*)(["'])(\.{1,2}\/[^"']*)\2/gu,
];

const stats = {
  filesMoved: 0,
  filesEdited: 0,
  specifiers: 0,
  byName: 0,
  byWorker: 0,
  relative: 0,
  declareModule: 0,
  unresolvedInMoved: [],
};
const edits = new Map();
const byGroup = {};
const group = (f) =>
  f.startsWith("services/platform/tests/e2e/")
    ? "journeys (tests/e2e)"
    : f.startsWith("services/platform/tests/")
      ? "unit tests (tests/)"
      : f.startsWith("services/platform/src/")
        ? "Worker src"
        : f.startsWith("services/platform/scripts/")
          ? "platform scripts"
          : f.startsWith("scripts/")
            ? "repo scripts"
            : f.startsWith("apps/")
              ? "apps"
              : f.startsWith("packages/")
                ? "packages"
                : "other";

for (const file of sources) {
  const fileNew = moves[file] ?? file;
  const text = readFileSync(join(root, file), "utf8");
  let changed = 0;
  let next = text;
  for (const pattern of patterns) {
    next = next.replace(pattern, (whole, lead, quote, spec) => {
      const target = resolveOld(file, spec);
      if (!target) {
        if (moves[file]) stats.unresolvedInMoved.push(`${file}: ${spec}`);
        return whole;
      }
      const targetMoved =
        moves[target.file] !== undefined ||
        (plan.repackage === true &&
          (packageOf(target.file) !== null || packageOf(file) !== null));
      if (!moves[file] && !targetMoved) return whole;
      const { spec: replacement, by } = newSpecifier(fileNew, target);
      if (replacement === spec) return whole;
      changed += 1;
      stats.specifiers += 1;
      if (by === "name") stats.byName += 1;
      else if (by === "worker") stats.byWorker += 1;
      else stats.relative += 1;
      if (/declare\s+module/u.test(lead)) stats.declareModule += 1;
      return `${lead}${quote}${replacement}${quote}`;
    });
  }
  if (changed > 0) {
    edits.set(file, next);
    stats.filesEdited += 1;
    const key = moves[file] ? "moved files" : group(file);
    byGroup[key] ??= { files: 0, specifiers: 0 };
    byGroup[key].files += 1;
    byGroup[key].specifiers += changed;
  }
}

if (!dry) {
  for (const [file, text] of edits) writeFileSync(join(root, file), text);
  for (const [from, to] of Object.entries(moves)) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    execSync(`git mv "${from}" "${to}"`, { cwd: root });
    stats.filesMoved += 1;
  }
}
console.log(JSON.stringify({ ...stats, byGroup }, null, 2));
