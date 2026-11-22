#!/usr/bin/env node
// Moves one module of the Platform Worker into a workspace package of its own
// (Refactor 17, Stage B, decision D1). docs/runbooks/refactor-17-module-move.md
// tells how to use it on the day of a move and on an open branch.
//
//   node scripts/refactor-17/move-module.mjs <plan.json>               do the move
//   node scripts/refactor-17/move-module.mjs <plan.json> --check       change nothing; exit 1 when a run would change a file
//   node scripts/refactor-17/move-module.mjs <plan.json> --sync-plan   add the files that scripts/layers.json gives the module to the plan
//
//   --root <folder>    the checkout to change (default: the checkout of this script)
//   --no-install       do not run pnpm install after the change
//   --stage            `git add` each file that the run wrote, by its path
//   --report <file>    write the counts as JSON
//
// The plan (scripts/refactor-17/plans/<module>.json) names the module of
// scripts/layers.json, each source file with its place in the target folder,
// the package, and the text edits of the configs that cannot read
// scripts/lib/source-roots.mjs.
//
// One run does the whole move, in this order:
//    1. `git mv` of each source file that is still at its old path.
//    2. package.json and tsconfig.json of the new package: source only, with
//       an `exports` map and no build step. With `package.typeCheck: false`
//       in the plan, the package has no check:types script. With
//       `package.existing: true`, the module joins a package that exists:
//       its manifest gets the export entries and the dependencies of the
//       plan, and it keeps the rest and its tsconfig.
//    3. The workspace entry, and the dependency in each package that imports
//       the module by name.
//    4. Each import of a moved file, in each source file of the tree: `from`,
//       `import()`, `declare module`, `require`, `vi.mock`, `new URL`. A file
//       of a workspace package imports the module by name. A file with no
//       package of its own (scripts/) keeps a relative path.
//    5. Each path of a moved file in a lint, a ratchet, a config, a Dockerfile,
//       a CI file and a document, and the path of each folder that moves
//       whole. Plans and evidence keep the old paths in their text; only
//       the target of a Markdown link to a moved file changes. A glob of the
//       Worker source that selects a moved file of a folder that does not
//       move whole is a fault: the plan adds the new path with an edit.
//    6. scripts/layers.json: one rule for the folder, the package and the
//       cover. The rule of a folder that moved whole goes. A package that
//       exists keeps its line, which gives the module each file in it.
//    7. The ratchet files in their own order. No count changes.
//    8. The text edits of the plan.
//    9. Prettier, only for a file that this run changed and that was clean
//       before the change. A file of `keepForm` in the plan keeps each import
//       on its line, where the wrap of Prettier would move a ratchet.
//   10. `git add` of the new package files, `pnpm install`, then the
//       commands of `regenerate` in the plan.
//
// A second run on a moved tree changes nothing. On a branch that was cut
// before the move, run it after the rebase: it changes each import that the
// branch added. It reads the old paths from the plan, so it needs no old file.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, getFileInfo, resolveConfig } from "prettier";

import { clonePairKey, clonesBaselineText } from "../lib/clones-ratchet.mjs";

const started = Date.now();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const planArgument = args.find(
  (arg, index) =>
    !arg.startsWith("--") && !["--root", "--report"].includes(args[index - 1]),
);
if (planArgument === undefined) {
  console.error(
    "usage: node scripts/refactor-17/move-module.mjs <plan.json> [--check] [--sync-plan] [--root <folder>] [--no-install] [--stage] [--report <file>]",
  );
  process.exit(2);
}
const root = resolve(
  option("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);
const planPath = resolve(planArgument);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const checkOnly = flag("--check");

const LAYER_MAP = "scripts/layers.json";
const CLONES_RATCHET = "scripts/clones-ratchet.json";
const WORKSPACE_FILE = "pnpm-workspace.yaml";

// Plans, refactor documents, evidence and handovers keep the old paths
// (AGENTS.md, "Old and new names"). The plans of this script name the old
// paths on purpose.
const FROZEN = [
  /^docs\/(plan-|refactor-|evidence\/|handoffs\/|history\/)/,
  /(^|\/)docs\/plan[^/]*\.md$/,
  /^scripts\/refactor-17\//,
];
// Bundles, vendored code and files that a tool writes.
const UNREAD = [
  /(^|\/)(node_modules|dist|vendor|wasm-pkg|media-wasm-pkg|generated)\//,
  /^apps\/portal\/public\//,
  /^pnpm-lock\.yaml$/,
];
const SOURCE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|vue)$/;
const TEXT =
  /(\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|vue|json|jsonc|md|yml|yaml|toml|sh|css|html|py|rs)|(^|\/)(Dockerfile[^/]*|\.dockerignore|Caddyfile))$/;

const faults = [];
const notes = [];

function git(...parameters) {
  return execFileSync("git", parameters, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}
function onDisk(path) {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The plan and the tree. Each path below is a path after the move: a file
// that still waits for its `git mv` is read from its old path.

/** old path -> new path, for each file of the plan. */
const planFiles = new Map(
  Object.entries(plan.files).map(([from, inside]) => [
    from,
    `${plan.target}/${inside}`,
  ]),
);
const oldPathOf = new Map([...planFiles].map(([from, to]) => [to, from]));
const packageName = plan.package.name;

if (posix.basename(plan.target) !== packageName.split("/").pop()) {
  faults.push(
    `${planArgument}: the folder ${plan.target} and the package ${packageName} need the same last name. scripts/check-layers.mjs finds the module of a package by that name.`,
  );
}

/** new path -> old path, for each file that still waits for its move. */
const waiting = new Map();
for (const [from, to] of planFiles) {
  const before = onDisk(from);
  const after = onDisk(to);
  if (before && after) {
    faults.push(
      `${from} and ${to} both exist. Join the two files, then delete the old one.`,
    );
  } else if (!before && !after) {
    faults.push(
      `${from} is in the plan, but neither it nor ${to} exists. Remove it from the plan.`,
    );
  } else if (before) waiting.set(to, from);
}
const stillOld = new Map([...waiting].map(([to, from]) => [from, to]));

const tree = git("ls-files", "-co", "--exclude-standard")
  .split("\n")
  .filter((path) => path !== "" && onDisk(path))
  .map((path) => stillOld.get(path) ?? path);
const known = new Set(tree);
const diskPath = (path) => waiting.get(path) ?? path;

const originals = new Map();
/** path -> the text that this run writes. */
const pending = new Map();
/** path -> the kinds of change, for the report. */
const kinds = new Map();

function original(path) {
  if (!originals.has(path)) {
    originals.set(
      path,
      onDisk(diskPath(path))
        ? readFileSync(join(root, diskPath(path)), "utf8")
        : null,
    );
  }
  return originals.get(path);
}
function textOf(path) {
  return pending.get(path) ?? original(path);
}
function put(path, text, kind) {
  if (text === textOf(path)) return;
  if (text === original(path)) pending.delete(path);
  else pending.set(path, text);
  const list = kinds.get(path) ?? new Set();
  list.add(kind);
  kinds.set(path, list);
  known.add(path);
}
function readJson(path) {
  return JSON.parse(textOf(path));
}
async function pretty(path, text) {
  const filepath = join(root, path);
  return format(text, { ...(await resolveConfig(filepath)), filepath });
}
async function putJson(path, value, kind) {
  put(path, await pretty(path, `${JSON.stringify(value, null, 2)}\n`), kind);
}

// A plan names each file at its place on the day of its move. A later move of
// another module can take a file of keepForm or of an edit: the plans beside
// this one give its place now.
const laterMoves = new Map();
for (const name of readdirSync(dirname(planPath))) {
  const other = join(dirname(planPath), name);
  if (!name.endsWith(".json") || other === planPath) continue;
  const otherPlan = JSON.parse(readFileSync(other, "utf8"));
  for (const [from, inside] of Object.entries(otherPlan.files ?? {})) {
    laterMoves.set(from, `${otherPlan.target}/${inside}`);
  }
}
function laterPath(path) {
  let current = path;
  while (!known.has(current) && laterMoves.has(current)) {
    current = laterMoves.get(current);
  }
  return known.has(current) ? current : path;
}

// ---------------------------------------------------------------------------
// The module in scripts/layers.json.

const layerMapAtStart = JSON.parse(original(LAYER_MAP));
const rulesAtStart = Object.entries(layerMapAtStart.rules).sort(
  ([a], [b]) => b.length - a.length,
);
function moduleAtStart(path) {
  return (
    layerMapAtStart.files[path] ??
    rulesAtStart.find(([prefix]) => path.startsWith(prefix))?.[1] ??
    null
  );
}
const outside = tree
  .map(diskPath)
  .filter(
    (path) =>
      moduleAtStart(path) === plan.module &&
      !path.startsWith(`${plan.target}/`) &&
      !planFiles.has(path),
  );

if (flag("--sync-plan")) {
  const added = [];
  for (const path of outside) {
    const prefix = Object.keys(plan.sourcePrefixes ?? {})
      .sort((a, b) => b.length - a.length)
      .find((candidate) => path.startsWith(candidate));
    if (prefix === undefined) {
      faults.push(
        `${path}: no line of sourcePrefixes in the plan starts this path. Add the file to "files" by hand.`,
      );
      continue;
    }
    plan.files[path] = plan.sourcePrefixes[prefix] + path.slice(prefix.length);
    added.push(path);
  }
  if (faults.length > 0) {
    console.error(faults.join("\n"));
    process.exit(1);
  }
  if (added.length > 0) {
    writeFileSync(
      planPath,
      await format(`${JSON.stringify(plan, null, 2)}\n`, {
        ...(await resolveConfig(planPath)),
        filepath: planPath,
      }),
    );
  }
  console.log(
    added.length === 0
      ? `The plan names each file of ${plan.module}.`
      : `Added ${added.length} files to the plan:\n  ${added.join("\n  ")}`,
  );
  process.exit(0);
}
for (const path of outside) {
  faults.push(
    `${path}: ${LAYER_MAP} gives it to ${plan.module}, and the plan does not name it. Run this script with --sync-plan.`,
  );
}
// A file that moved has no line of its own in the map any more: a rule of
// its old folder can name another module.
for (const from of stillOld.keys()) {
  const module = moduleAtStart(from);
  if (module !== null && module !== plan.module) {
    faults.push(
      `${from}: ${LAYER_MAP} gives it to ${module}, and the plan moves ${plan.module}.`,
    );
  }
}
stopOnFaults();

// ---------------------------------------------------------------------------
// 2. The package files.

const versions = JSON.parse(original(plan.package.versionsFrom));
function versionOf(name) {
  const version = { ...versions.dependencies, ...versions.devDependencies }[
    name
  ];
  if (version === undefined) {
    faults.push(
      `${plan.package.versionsFrom} has no version of ${name}, which the plan gives the package.`,
    );
  }
  return version;
}
const manifestPath = `${plan.target}/package.json`;
/** A manifest with one more dependency, after its last workspace dependency. */
function withDependency(manifest, name, version) {
  if (
    manifest.dependencies?.[name] !== undefined ||
    manifest.devDependencies?.[name] !== undefined
  ) {
    return manifest;
  }
  const entries = Object.entries(manifest.dependencies ?? {});
  const last = entries.findLastIndex(([, value]) =>
    String(value).startsWith("workspace:"),
  );
  entries.splice(last + 1, 0, [name, version]);
  return { ...manifest, dependencies: Object.fromEntries(entries) };
}
if (plan.package.existing === true) {
  // The module joins a package that exists: the manifest gets the export
  // entries and the dependencies of the plan and keeps the rest. The package
  // keeps its tsconfig and its scripts.
  const manifest =
    original(manifestPath) === null ? null : readJson(manifestPath);
  if (manifest?.name !== packageName) {
    faults.push(
      `${planArgument}: package.existing is true, and ${manifestPath} is not the manifest of ${packageName}.`,
    );
  } else {
    let next = { ...manifest, exports: { ...manifest.exports } };
    for (const [key, value] of Object.entries(plan.package.exports)) {
      const now = next.exports[key];
      if (now !== undefined && JSON.stringify(now) !== JSON.stringify(value)) {
        faults.push(
          `${manifestPath}: the export ${key} has another target than the plan gives.`,
        );
      }
      next.exports[key] = value;
    }
    for (const [name, version] of Object.entries(
      plan.package.dependencies ?? {},
    )) {
      next = withDependency(next, name, version);
    }
    if (JSON.stringify(next) !== JSON.stringify(manifest)) {
      await putJson(manifestPath, next, "package");
    }
  }
} else {
  await putJson(
    manifestPath,
    {
      name: packageName,
      version: "0.1.0",
      private: true,
      type: "module",
      exports: plan.package.exports,
      // A package that reads an `Env` key that another module merges fails a
      // type check of its own; the Worker program checks its files.
      scripts:
        plan.package.typeCheck === false
          ? undefined
          : { "check:types": "tsrs --noEmit" },
      dependencies: plan.package.dependencies,
      devDependencies: Object.fromEntries(
        plan.package.devDependencies.map((name) => [name, versionOf(name)]),
      ),
    },
    "package",
  );
  await putJson(
    `${plan.target}/tsconfig.json`,
    plan.package.tsconfig,
    "package",
  );
}

/** The specifier of a file of the package, by name, or null. */
function specifierByName(inside) {
  const subpath = `./${inside.replace(/\.(d\.ts|tsx?|mts|mjs|js)$/, "")}`;
  for (const [key, value] of Object.entries(plan.package.exports)) {
    const target = typeof value === "string" ? value : value.default;
    const [head, tail] = key.split("*");
    const match =
      tail === undefined
        ? subpath === key
          ? ""
          : null
        : subpath.startsWith(head) &&
            subpath.endsWith(tail) &&
            subpath.length >= key.length - 1
          ? subpath.slice(head.length, subpath.length - tail.length)
          : null;
    if (match === null) continue;
    if (target.replace("*", match) === `./${inside}`) {
      return `${packageName}${subpath.slice(1)}`;
    }
  }
  // An entry whose name is not its path, such as "./boundary":
  // "./src/boundary.ts" in a package that exists.
  for (const [key, value] of Object.entries(plan.package.exports)) {
    const target = typeof value === "string" ? value : value.default;
    if (!key.includes("*") && target === `./${inside}`) {
      return key === "." ? packageName : `${packageName}${key.slice(1)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. The imports.

/** The folder of the nearest package.json above a file, "" for the root. */
const manifestFolders = new Map();
function packageFolderOf(path) {
  let folder = posix.dirname(path);
  const walked = [];
  while (folder !== "." && folder !== "") {
    if (manifestFolders.has(folder)) break;
    walked.push(folder);
    if (known.has(`${folder}/package.json`)) {
      manifestFolders.set(folder, folder);
      break;
    }
    folder = posix.dirname(folder);
  }
  const found =
    folder === "." || folder === "" ? "" : manifestFolders.get(folder);
  for (const step of walked) manifestFolders.set(step, found);
  return found;
}

const SUFFIXES = [".ts", ".tsx", ".mts", ".d.ts", ".mjs", ".js"];
const INDEXES = ["/index.ts", "/index.tsx", "/index.mjs", "/index.js"];
/** The file that a relative specifier names, in a set of paths. */
function resolveIn(has, folder, specifier) {
  const base = posix.normalize(posix.join(folder, specifier));
  if (has(base)) return { file: base, style: "exact" };
  for (const suffix of SUFFIXES) {
    if (has(base + suffix)) return { file: base + suffix, style: "bare" };
  }
  if (base.endsWith(".js")) {
    for (const suffix of [".ts", ".tsx"]) {
      const file = base.replace(/\.js$/, suffix);
      if (has(file)) return { file, style: "js" };
    }
  }
  for (const index of INDEXES) {
    if (has(base + index)) return { file: base + index, style: "folder" };
  }
  return null;
}
const inPlan = (path) => planFiles.has(path);
const inTree = (path) => known.has(path);

function relativeSpecifier(fromFolder, target, style) {
  const path =
    style === "bare"
      ? target.replace(/\.(d\.ts|tsx?|mts|mjs|js)$/, "")
      : style === "js"
        ? target.replace(/\.tsx?$/, ".js")
        : style === "folder"
          ? target.replace(/\/index\.(tsx?|mjs|js)$/, "")
          : target;
  const relative = posix.relative(fromFolder, path);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

const LEADS = [
  String.raw`\bfrom\s*`,
  String.raw`\bimport\s*(?:\(\s*)?`,
  String.raw`\bdeclare\s+module\s+`,
  String.raw`\brequire\s*\(\s*`,
  // `vi.importActual<Record<string, unknown>>(…)`: a type argument with one
  // level of nesting.
  String.raw`\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(\s*`,
  String.raw`\bnew\s+(?:Node)?U(?:RL|rl)\s*\(\s*`,
  String.raw`\bimport\.meta\.(?:glob|resolve)\s*\(\s*`,
];
const SPECIFIER = new RegExp(
  `(${LEADS.join("|")})(["'\`])(\\.{1,2}/[^"'\`\\n]*)\\2`,
  "g",
);
const QUOTED_RELATIVE = /(["'`])(\.{1,2}\/[^"'`\n]*)\1/g;

const counts = {
  specifiers: 0,
  byName: 0,
  relative: 0,
  declareModule: 0,
  paths: 0,
};
/** package folder -> true, for each package that imports the module by name. */
const consumers = new Set();

/** The new specifier of a relative specifier, or null when it stays. */
function newSpecifier(path, specifier) {
  const [bare, query = ""] = specifier.split(/(?=[?#])/, 2);
  const folder = posix.dirname(path);
  const oldPath = oldPathOf.get(path);
  if (oldPath !== undefined) {
    // A moved file. Its specifiers were written for its old folder.
    if (resolveIn(inTree, folder, bare) !== null) return null;
    const moved = resolveIn(inPlan, posix.dirname(oldPath), bare);
    if (moved !== null) {
      return (
        relativeSpecifier(folder, planFiles.get(moved.file), moved.style) +
        query
      );
    }
    const left = resolveIn(inTree, posix.dirname(oldPath), bare);
    if (left !== null) {
      faults.push(
        `${oldPath} imports ${left.file}, which does not move. A package cannot import a file of the Worker: move that file first, or give the module a port.`,
      );
    }
    return null;
  }
  const target = resolveIn(inPlan, folder, bare);
  if (target === null) return null;
  const moved = planFiles.get(target.file);
  const owner = packageFolderOf(path);
  if (owner === "" || owner === plan.target) {
    return relativeSpecifier(folder, moved, target.style) + query;
  }
  const byName = specifierByName(moved.slice(plan.target.length + 1));
  if (byName === null) {
    faults.push(
      `${path} imports ${target.file}, and the exports map of the plan has no entry for it.`,
    );
    return null;
  }
  consumers.add(owner);
  return byName + query;
}

for (const path of tree) {
  if (!SOURCE.test(path) || UNREAD.some((pattern) => pattern.test(path))) {
    continue;
  }
  if (FROZEN.some((pattern) => pattern.test(path))) continue;
  const text = original(path);
  let changed = 0;
  const next = text.replace(SPECIFIER, (whole, lead, quote, specifier) => {
    const replacement = newSpecifier(path, specifier);
    if (replacement === null || replacement === specifier) return whole;
    changed += 1;
    counts.specifiers += 1;
    if (replacement.startsWith(".")) counts.relative += 1;
    else counts.byName += 1;
    if (/declare\s+module/.test(lead)) counts.declareModule += 1;
    return `${lead}${quote}${replacement}${quote}`;
  });
  if (changed > 0) put(path, next, "import");
  // A quoted path of a moved file that is no import: a person must read it.
  if (!oldPathOf.has(path)) {
    for (const match of next.matchAll(QUOTED_RELATIVE)) {
      const bare = match[2].split(/(?=[?#])/, 2)[0];
      if (resolveIn(inPlan, posix.dirname(path), bare) === null) continue;
      const line = next.slice(0, match.index).split("\n").length;
      faults.push(
        `${path}:${line}: ${match[0]} names a moved file, and it is not an import that this script knows. Change it by hand, or add an edit to the plan.`,
      );
    }
  }
  if (next.includes(`${packageName}/`) || next.includes(`"${packageName}"`)) {
    const owner = packageFolderOf(path);
    if (owner !== "" && owner !== plan.target) consumers.add(owner);
  }
}

// ---------------------------------------------------------------------------
// 3. The workspace entry and the dependencies.

{
  const text = textOf(WORKSPACE_FILE);
  const entry = `  - ${plan.workspaceEntry}`;
  const lines = text.split("\n");
  if (!lines.includes(entry)) {
    const start = lines.indexOf("packages:");
    let end = start + 1;
    while (/^\s+- /.test(lines[end] ?? "")) end += 1;
    if (start === -1) {
      faults.push(`${WORKSPACE_FILE}: no "packages:" list`);
    } else {
      lines.splice(end, 0, entry);
      put(WORKSPACE_FILE, lines.join("\n"), "config");
    }
  }
}
for (const folder of [...consumers].sort()) {
  const path = `${folder}/package.json`;
  const manifest = readJson(path);
  // After the last workspace dependency, so that they stay together.
  const next = withDependency(manifest, packageName, "workspace:*");
  if (next !== manifest) await putJson(path, next, "config");
}

// ---------------------------------------------------------------------------
// 5. The paths in lints, ratchets, configs and documents.

if (planFiles.size === 0) {
  faults.push(`${planArgument}: the plan names no file`);
  stopOnFaults();
}
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FROM_ROOT = new RegExp(
  `(?<![\\w./@-])(${[...planFiles.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escaped)
    .join("|")})(?![\\w/-])`,
  "g",
);
const RELATIVE_PATH = /(?<![\w/@.-])(\.{1,2}\/[\w@./-]+)/g;
/** True for a file or a folder of the tree, at its path after the move. */
const exists = (path) =>
  known.has(path) || existsSync(join(root, diskPath(path)));

// A folder moves whole when each tracked file in it is in the plan and keeps
// its place below the folder. A lint, a config or a document can name such a
// folder (`.../data/shared-rows/`, `.../actor-journal/**/*.ts`): the name
// moves with it.
/** old folder -> new folder, for each folder that moves whole. */
const movedFolders = new Map();
const notWhole = new Set();
const treeOnDisk = tree.map(diskPath);
for (const [from, to] of planFiles) {
  let folder = posix.dirname(from);
  let next = posix.dirname(to);
  while (folder !== "." && posix.basename(folder) === posix.basename(next)) {
    if (notWhole.has(folder)) break;
    if (!movedFolders.has(folder)) {
      const prefix = `${folder}/`;
      const whole = treeOnDisk
        .filter((path) => path.startsWith(prefix))
        .every(
          (path) =>
            planFiles.get(path) === `${next}/${path.slice(prefix.length)}`,
        );
      if (!whole) {
        notWhole.add(folder);
        break;
      }
      movedFolders.set(folder, next);
    }
    folder = posix.dirname(folder);
    next = posix.dirname(next);
  }
}
const FOLDER_FROM_ROOT =
  movedFolders.size === 0
    ? null
    : new RegExp(
        `(?<![\\w./@-])(${[...movedFolders.keys()]
          .sort((a, b) => b.length - a.length)
          .map(escaped)
          .join("|")})(?=/|[^\\w./-]|$)`,
        "g",
      );
// A glob of the Worker source below its root that selects a moved file, in a
// folder that does not move whole: the moved file leaves the glob.
const GLOB =
  /(?<![\w./@-])(services\/platform\/src\/[\w@./-]*\*[\w@.*/{},-]*)/g;
// A path or a glob in the target folder, which can select the moved file.
const TARGET_PATH = new RegExp(
  `(?<![\\w./@-])(${escaped(plan.target)}/[\\w@.*/{},-]*)`,
  "g",
);
function globPattern(glob) {
  let source = "";
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at];
    if (glob.startsWith("**/", at)) {
      source += "(?:.*/)?";
      at += 2;
    } else if (char === "*") source += "[^/]*";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (
      char === "," &&
      source.lastIndexOf("(?:") > source.lastIndexOf(")")
    )
      source += "|";
    else source += escaped(char);
  }
  return new RegExp(`^${source}$`);
}

for (const path of tree) {
  if (!TEXT.test(path) || UNREAD.some((pattern) => pattern.test(path))) {
    continue;
  }
  if (FROZEN.some((pattern) => pattern.test(path))) continue;
  if ((plan.regenerate ?? []).some((step) => step.writes.includes(path))) {
    continue;
  }
  const text = textOf(path);
  let changed = 0;
  let next = text.replace(FROM_ROOT, (_, from) => {
    changed += 1;
    return planFiles.get(from);
  });
  if (FOLDER_FROM_ROOT !== null) {
    next = next.replace(FOLDER_FROM_ROOT, (_, from) => {
      changed += 1;
      return movedFolders.get(from);
    });
  }
  // A path from the folder of a config or of a document. The imports of a
  // source file are done above.
  if (!SOURCE.test(path) && !oldPathOf.has(path)) {
    next = next.replace(RELATIVE_PATH, (whole) => {
      const trimmed = whole.replace(/[.,;:]+$/, "");
      const target = posix.normalize(posix.join(posix.dirname(path), trimmed));
      if (!planFiles.has(target)) return whole;
      changed += 1;
      return (
        relativeSpecifier(posix.dirname(path), planFiles.get(target), "exact") +
        whole.slice(trimmed.length)
      );
    });
  }
  // A moved document or config: its paths were written for its old folder.
  if (!SOURCE.test(path) && oldPathOf.has(path)) {
    const oldFolder = posix.dirname(oldPathOf.get(path));
    next = next.replace(RELATIVE_PATH, (whole) => {
      const trimmed = whole.replace(/[.,;:]+$/, "");
      const here = posix.normalize(posix.join(posix.dirname(path), trimmed));
      if (exists(here)) return whole;
      const before = posix.normalize(posix.join(oldFolder, trimmed));
      const target = planFiles.get(before) ?? (exists(before) ? before : null);
      if (target === null) return whole;
      changed += 1;
      return (
        relativeSpecifier(posix.dirname(path), target, "exact") +
        whole.slice(trimmed.length)
      );
    });
  }
  if (changed === 0) continue;
  counts.paths += changed;
  put(path, next, "path");
}

// A frozen document keeps the old paths in its text. A Markdown link is the
// exception: `pnpm lint:doc-links` refuses a link to a file that is gone, so
// the target of a link to a moved file follows the file.
const MARKDOWN_LINK = /(\]\()([^)\s#]+)(?=[)#\s])/g;
for (const path of tree) {
  if (!path.endsWith(".md")) continue;
  if (!FROZEN.some((pattern) => pattern.test(path))) continue;
  const text = textOf(path);
  if (text === null) continue;
  let changed = 0;
  const next = text.replace(MARKDOWN_LINK, (whole, lead, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) {
      return whole;
    }
    const moved = planFiles.get(
      posix.normalize(posix.join(posix.dirname(path), target)),
    );
    if (moved === undefined) return whole;
    changed += 1;
    return lead + relativeSpecifier(posix.dirname(path), moved, "exact");
  });
  if (changed === 0) continue;
  counts.paths += changed;
  put(path, next, "path");
}

// ---------------------------------------------------------------------------
// 6. scripts/layers.json: one rule for the folder, the package, the cover.

{
  const map = readJson(LAYER_MAP);
  const rule = `${plan.target}/`;
  for (const [from, to] of planFiles) {
    for (const key of [from, to]) {
      if (map.files[key] === undefined) continue;
      if (map.files[key] !== plan.module) {
        faults.push(`${LAYER_MAP}: ${key} is not a file of ${plan.module}`);
      }
      delete map.files[key];
    }
  }
  if (plan.package.existing === true) {
    // The line of the package gives the module each file in it.
    if (map.packages[plan.target] !== plan.module) {
      faults.push(
        `${LAYER_MAP}: packages gives ${plan.target} to ${map.packages[plan.target] ?? "no module"}, and the plan moves ${plan.module} into it.`,
      );
    }
  } else {
    // A rule of a folder that moved whole is now inside the rule of the
    // target.
    for (const key of Object.keys(map.rules)) {
      if (
        key !== rule &&
        key.startsWith(rule) &&
        map.rules[key] === plan.module
      ) {
        delete map.rules[key];
      }
    }
    if (map.rules[rule] === undefined) {
      map.rules = { [rule]: plan.module, ...map.rules };
    } else if (map.rules[rule] !== plan.module) {
      faults.push(`${LAYER_MAP}: the rule ${rule} names another module`);
    }
    if (map.packages[plan.target] === undefined) {
      map.packages = { [plan.target]: plan.module, ...map.packages };
    }
    if (!map.covers.some((cover) => rule.startsWith(cover))) {
      map.covers.push(`${plan.target.split("/")[0]}/`);
    }
  }
  await putJson(LAYER_MAP, map, "layer map");
}

// ---------------------------------------------------------------------------
// 7. The ratchet files keep their order. The clone baseline names a pair by
// its two files in order. Each other ratchet that was in the order of its
// keys stays in that order. No count of a ratchet changes here.

if (pending.has(CLONES_RATCHET)) {
  const baseline = readJson(CLONES_RATCHET);
  const pairs = {};
  for (const [pair, entry] of Object.entries(baseline.pairs)) {
    const [first, second] = pair.split(" = ");
    const key = clonePairKey(first, second);
    if (pairs[key] !== undefined) {
      faults.push(`${CLONES_RATCHET}: the move gives two lines for ${key}`);
    }
    pairs[key] = entry;
  }
  put(CLONES_RATCHET, clonesBaselineText(baseline.total, pairs), "path");
}
const inOrder = (keys) =>
  keys.every((key, at) => at === 0 || keys[at - 1] < key);
function sameOrder(before, after) {
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return after;
  }
  if (Array.isArray(after)) {
    const sorted =
      before.every((item) => typeof item === "string") &&
      inOrder(before) &&
      !inOrder(after);
    return sorted ? [...after].sort() : after;
  }
  const beforeValues = Object.values(before);
  const entries = Object.entries(after).map(([key, value], at) => [
    key,
    sameOrder(beforeValues[at], value),
  ]);
  if (inOrder(Object.keys(before)) && !inOrder(Object.keys(after))) {
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
  }
  return Object.fromEntries(entries);
}
for (const path of [...pending.keys()]) {
  if (!/^scripts\/[^/]+-ratchet\.json$/.test(path)) continue;
  if (path === CLONES_RATCHET) continue;
  const before = JSON.parse(original(path));
  const plain = `${JSON.stringify(before, null, 2)}\n` === original(path);
  const ordered = sameOrder(before, readJson(path));
  put(
    path,
    plain
      ? `${JSON.stringify(ordered, null, 2)}\n`
      : await pretty(path, `${JSON.stringify(ordered, null, 2)}\n`),
    "path",
  );
}

// ---------------------------------------------------------------------------
// 8. The text edits of the plan: the configs that find files by a root name
// and that cannot read scripts/lib/source-roots.mjs.

for (const plannedEdit of plan.edits ?? []) {
  const edit = { ...plannedEdit, file: laterPath(plannedEdit.file) };
  const text = textOf(edit.file);
  if (text === null) {
    faults.push(`${edit.file}: the plan edits it, and it does not exist`);
  } else if (text.includes(edit.replace)) {
    // Done by an earlier run.
  } else if (text.includes(edit.find)) {
    put(edit.file, text.split(edit.find).join(edit.replace), "config");
  } else {
    faults.push(
      `${edit.file}: the plan looks for this text, and the file does not have it:\n    ${edit.find}\n  Correct the edit in the plan (${edit.why}).`,
    );
  }
}

// A glob of the Worker source that selects a moved file, after the edits.
for (const path of tree) {
  if (!TEXT.test(path) || UNREAD.some((pattern) => pattern.test(path))) {
    continue;
  }
  if (FROZEN.some((pattern) => pattern.test(path))) continue;
  const text = textOf(path);
  if (text === null || !text.includes("*")) continue;
  const targetPatterns = [...text.matchAll(TARGET_PATH)].map((match) =>
    globPattern(match[1]),
  );
  for (const match of text.matchAll(GLOB)) {
    const pattern = globPattern(match[1]);
    const selected = [...planFiles.keys()].find(
      (from) =>
        pattern.test(from) &&
        !targetPatterns.some((target) => target.test(planFiles.get(from))),
    );
    if (selected === undefined) continue;
    const line = text.slice(0, match.index).split("\n").length;
    faults.push(
      `${path}:${line}: the glob ${match[1]} selects ${selected}, which moves to ${planFiles.get(selected)}. Add the new path to the plan as an edit.`,
    );
  }
}

// A file that a Dockerfile copies runs with no workspace package beside it.
for (const path of tree) {
  if (!/(^|\/)Dockerfile[^/]*$/.test(path)) continue;
  for (const line of textOf(path).split("\n")) {
    if (!/^\s*COPY\s/.test(line) || /--from=/.test(line)) continue;
    for (const source of line.trim().split(/\s+/).slice(1, -1)) {
      if (kinds.get(source)?.has("import")) {
        faults.push(
          `${path} copies ${source}, which imports ${packageName}. The image has no such package: copy the package too, or keep the file free of it.`,
        );
      }
    }
  }
}
stopOnFaults();

// ---------------------------------------------------------------------------
// 9. Prettier, for a file that was clean before this run.
//
// An import by package name is longer than the relative import, so Prettier
// wraps some of them: three more lines, and one more comma. Two ratchets
// count that as new code. jscpd finds a copy where two files with the same
// imports pass its token limit, and scripts/check-layer-debts.mjs counts the
// lines of the logic files of a Worker module. The move adds no code, so for
// a file of keepForm in the plan each import stays on its line and Prettier
// does not run. The plan gives the reason for each file.

const keepForm = new Map(
  (plan.keepForm ?? []).map((entry) => [laterPath(entry.file), entry.why]),
);
for (const file of keepForm.keys()) {
  if (!known.has(file)) {
    faults.push(
      `${planArgument}: keepForm names ${file}, which does not exist`,
    );
  }
}
stopOnFaults();

let formatted = 0;
const leftUnformatted = [];
const keptForm = [];
for (const [path, text] of [...pending]) {
  const before = original(path);
  if (before === null) continue;
  if (keepForm.has(path)) {
    keptForm.push(path);
    continue;
  }
  const filepath = join(root, path);
  const info = await getFileInfo(filepath, {
    ignorePath: join(root, ".prettierignore"),
  });
  if (info.ignored || info.inferredParser === null) continue;
  const options = { ...(await resolveConfig(filepath)), filepath };
  let clean;
  try {
    clean = (await format(before, options)) === before;
  } catch {
    clean = false;
  }
  if (!clean) {
    leftUnformatted.push(path);
    continue;
  }
  const next = await format(text, options);
  if (next === text) continue;
  formatted += 1;
  put(path, next, "format");
}

// ---------------------------------------------------------------------------
// The report, and the change.

function groupOf(path) {
  if (oldPathOf.has(path)) return "moved files";
  if (path.startsWith(`${plan.target}/`)) return "new package files";
  if (/^services\/platform\/tests\/e2e\//.test(path)) return "journeys";
  if (/^services\/platform\/tests\//.test(path)) return "unit tests";
  if (/^services\/platform\/src\//.test(path)) return "Worker source";
  if (
    path === "eslint.config.mjs" ||
    /^scripts\/(check-[^/]+\.mjs|[^/]+-ratchet\.json|layers\.json|lib\/)/.test(
      path,
    )
  ) {
    return "lints and ratchets";
  }
  if (/\.md$/.test(path)) return "documents";
  if (SOURCE.test(path)) {
    return path.startsWith("scripts/") ? "repository scripts" : "other source";
  }
  return "configs";
}
const groups = {};
for (const path of new Set([...pending.keys(), ...waiting.keys()])) {
  const group = groupOf(path);
  groups[group] = (groups[group] ?? 0) + 1;
}
const report = {
  plan: planArgument,
  module: plan.module,
  package: packageName,
  moved: waiting.size,
  changed: pending.size,
  groups,
  ...counts,
  formatted,
  notFormatted: leftUnformatted.length,
  keptForm,
  consumers: [...consumers].sort(),
};

function printReport() {
  console.log(
    `${plan.module} -> ${plan.target} (${packageName}): ${waiting.size} files to move, ${pending.size} files to write.`,
  );
  for (const [group, count] of Object.entries(groups).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`${String(count).padStart(6)}  ${group}`);
  }
  console.log(
    `${counts.specifiers} imports (${counts.byName} by name, ${counts.relative} relative, ${counts.declareModule} declare module), ${counts.paths} paths in other files.`,
  );
  console.log(
    `Prettier changed ${formatted} of the files. ${leftUnformatted.length} changed files were not clean before the run, so they keep their form.`,
  );
  if (keptForm.length > 0) {
    console.log(
      `${keptForm.length} files keep their form by the plan (keepForm): ${keptForm.join(", ")}`,
    );
  }
  for (const note of notes) console.log(note);
}
printReport();
if (option("--report") !== undefined) {
  writeFileSync(
    resolve(option("--report")),
    `${JSON.stringify({ ...report, notFormattedFiles: leftUnformatted }, null, 2)}\n`,
  );
}

if (checkOnly) {
  if (pending.size + waiting.size > 0) {
    for (const path of [...pending.keys()].sort().slice(0, 40)) {
      console.log(`  would write ${path} (${[...kinds.get(path)].join(", ")})`);
    }
    if (pending.size > 40) console.log(`  and ${pending.size - 40} more`);
    process.exit(1);
  }
  console.log("Nothing to change.");
  process.exit(0);
}

const tracked = new Set(git("ls-files").split("\n"));
for (const [to, from] of waiting) {
  mkdirSync(join(root, posix.dirname(to)), { recursive: true });
  if (tracked.has(from)) git("mv", from, to);
  else renameSync(join(root, from), join(root, to));
}
for (const [path, text] of pending) {
  mkdirSync(join(root, posix.dirname(path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
// The lints read the tracked files, so the new package files are staged.
const created = [...pending.keys()].filter(
  (path) => original(path) === null && path.startsWith(`${plan.target}/`),
);
if (created.length > 0) git("add", "--", ...created);

// 10. The links of the new package, the lockfile and the generated pages.
const linked = [...consumers].every((folder) =>
  existsSync(join(root, folder, "node_modules", ...packageName.split("/"))),
);
const manifestsChanged = [...pending.keys()].some(
  (path) => path.endsWith("package.json") || path === WORKSPACE_FILE,
);
function run(command, parameters) {
  console.log(`> ${command} ${parameters.join(" ")}`);
  const result = spawnSync(command, parameters, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`${command} ${parameters.join(" ")} failed.`);
    process.exit(1);
  }
}
if (flag("--no-install")) {
  if (manifestsChanged || !linked) {
    console.log(
      "Run pnpm install: a package.json changed, or a link is absent.",
    );
  }
} else if (manifestsChanged || !linked) {
  run("pnpm", ["install", "--prefer-offline"]);
}
for (const step of plan.regenerate ?? []) run(step.run[0], step.run.slice(1));

// Only the files of this run: another session can have work in the tree.
if (flag("--stage")) {
  const written = [
    ...pending.keys(),
    ...(plan.regenerate ?? []).flatMap((step) => step.writes),
    "pnpm-lock.yaml",
  ].filter(onDisk);
  if (written.length > 0) git("add", "--", ...written);
}

console.log(
  pending.size + waiting.size === 0
    ? "Nothing to change."
    : `Done in ${((Date.now() - started) / 1000).toFixed(1)} s. ${flag("--stage") ? "Each file of this run is staged." : "The moves and the new package files are staged; stage the other files by path, or run with --stage."}`,
);

function stopOnFaults() {
  if (faults.length === 0) return;
  console.error([...new Set(faults)].join("\n"));
  console.error(`${faults.length} faults. Nothing is changed.`);
  process.exit(1);
}
