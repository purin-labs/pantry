#!/usr/bin/env node
// Renames a folder whole (Refactor 17, Stage B): each rename of
// scripts/refactor-17/folder-renames.mjs, the first is `services/platform` to
// `workers/platform`. docs/runbooks/refactor-17-module-move.md tells how to
// use it on the day of the rename and on an open branch.
//
//   node scripts/refactor-17/rename-folder.mjs                do the renames
//   node scripts/refactor-17/rename-folder.mjs --check        change nothing; exit 1 when a run would change a file
//   node scripts/refactor-17/rename-folder.mjs --local-files  list the local files that git ignores in an old folder
//   node scripts/refactor-17/rename-folder.mjs --move-local   move those files to the new folder
//
//   --root <folder>    the checkout to change (default: the checkout of this script)
//   --no-install       do not run pnpm install after the change
//   --stage            `git add` each file that the run wrote, by its path
//   --report <file>    write the counts and each changed relative path as JSON
//
// One run does the whole rename, in this order:
//    1. `git mv` of the folder when the new folder does not exist. Else (an
//       open branch after its rebase) `git mv` of each file that is still in
//       the old folder.
//    2. Each path from the root (`services/platform/...`) in each tracked
//       text file. Plans, refactor documents, evidence and handovers keep the
//       old path in their text (FROZEN); only the target of a Markdown link
//       changes there. scripts/refactor-17/ keeps its text: the move plans
//       name the old paths on purpose.
//    3. Each relative path that crosses the edge of the folder: from a file
//       outside into the folder (`../../services/platform/src/x.ts`), and from
//       a file of the folder to its old siblings (`../commerce/wrangler.jsonc`
//       becomes `../../services/commerce/wrangler.jsonc`). A path of a file of
//       the folder is read from the folder of the file, then from the folder
//       itself (the working folder of its package scripts and tests).
//    4. The keys of scripts/doc-links-ratchet.json, as the links of their
//       documents.
//    5. The ratchets and scripts/layers.json keep their order; the clone
//       baseline names each pair in the order of its paths. No count changes.
//    6. The text edits of the rename: the lists of root folders.
//    7. Prettier, only for a changed file that was clean before.
//    8. `pnpm install --prefer-offline`: the lockfile names the new folder.
//
// A second run on a renamed tree changes nothing. On an open branch, run it
// after the rebase: it moves each file that the branch added to the old
// folder, and it changes each old path that the branch added.
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

import {
  clonesBaselineAfterRename,
  formatWhenClean,
  FROZEN,
  keepOrder,
  MARKDOWN_LINK,
  relativeSpecifier,
  RELATIVE_PATH,
  UNREAD,
} from "../lib/tree-rewrite.mjs";
import {
  FOLDER_RENAMES,
  formerPath,
  inFolder,
  renamedPath,
} from "./folder-renames.mjs";

const started = Date.now();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve(
  option("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);
const checkOnly = flag("--check");

const SELF_FOLDER = /^scripts\/refactor-17\//;
const CLONES_RATCHET = "scripts/clones-ratchet.json";
const DOC_LINKS_RATCHET = "scripts/doc-links-ratchet.json";
const ORDERED = /^scripts\/([^/]+-ratchet|layers)\.json$/;
const BINARY =
  /\.(png|jpe?g|gif|webp|ico|svg|glb|gltf|bin|data|wasm|onnx|pdf|zip|gz|tgz|mp3|mp4|wav|woff2?|ttf|otf|mjb|stl|obj|npz|npy|xml|ktx2|hdr|exr)$/i;

const faults = [];

function git(...parameters) {
  return execFileSync("git", parameters, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inAnyFrom = (path) =>
  FOLDER_RENAMES.some(({ from }) => inFolder(path, from));

// ---------------------------------------------------------------------------
// The tree. Each path below is a path after the rename; a file that still
// waits for its `git mv` is read from its old path.

const listed = git("ls-files", "-co", "--exclude-standard")
  .split("\n")
  .filter((path) => path !== "" && existsSync(join(root, path)));
const trackedNow = new Set(git("ls-files").split("\n"));
/** new path -> old path, for each file that still waits for its move. */
const waiting = new Map();
for (const path of listed) {
  if (!inAnyFrom(path)) continue;
  const to = renamedPath(path);
  if (existsSync(join(root, to))) {
    faults.push(
      `${path} and ${to} both exist. Join the two files, then delete the old one.`,
    );
  }
  waiting.set(to, path);
}
const tree = listed.map(renamedPath);
const diskPath = (path) => waiting.get(path) ?? path;

/** The tree before the renames: its files and its folders. */
const formerFiles = new Set(tree.map(formerPath));
const formerFolders = new Set([""]);
for (const path of formerFiles) {
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
    formerFolders.add(path.slice(0, at));
  }
}
const topTwo = (path) => path.split("/").slice(0, 2).join("/");
/**
 * True when a path named a file or a folder before the renames. A path in a
 * folder of the second level that git ignores (`services/shop-gateway/dist`)
 * counts by that folder.
 */
function existedBefore(path) {
  if (formerFiles.has(path) || formerFolders.has(path)) return true;
  return (
    path.split("/").length > 2 &&
    !inAnyFrom(path) &&
    formerFolders.has(topTwo(path))
  );
}

const originals = new Map();
const pending = new Map();
const kinds = new Map();
function original(path) {
  if (!originals.has(path)) {
    let text = null;
    try {
      const bytes = readFileSync(join(root, diskPath(path)));
      if (!bytes.subarray(0, 8192).includes(0)) text = bytes.toString("utf8");
    } catch {
      text = null;
    }
    originals.set(path, text);
  }
  return originals.get(path);
}
const textOf = (path) => pending.get(path) ?? original(path);
function put(path, text, kind) {
  if (text === textOf(path)) return;
  if (text === original(path)) pending.delete(path);
  else pending.set(path, text);
  const list = kinds.get(path) ?? new Set();
  list.add(kind);
  kinds.set(path, list);
}

// ---------------------------------------------------------------------------
// 2. Paths from the root.

const FROM_ROOT = new RegExp(
  `(?<![\\w.@/-])(${FOLDER_RENAMES.map(({ from }) => escaped(from)).join("|")})(?![\\w-]|\\.\\w)`,
  "g",
);

// 3. Relative paths that cross the edge of a renamed folder.

/** "file: old -> new", for the report. */
const relativeChanges = [];
const keepTail = (whole, trimmed) => whole.slice(trimmed.length);
function trimmedPath(whole) {
  return whole.replace(/[,;:]+$/, "").replace(/(?<=\w)\.$/, "");
}
/** The folder of the package of a renamed file: its working folder. */
function packageFolderOf(path) {
  const rename = FOLDER_RENAMES.find(({ to }) => inFolder(path, to));
  return rename === undefined ? null : rename.to;
}

/**
 * The relative path `path` of the file `file` (at its place now) after the
 * renames, or `path` when it does not change.
 */
function renamedRelative(file, path) {
  const before = formerPath(file);
  const write = (folder, target) => {
    const next = relativeSpecifier(folder, target, "exact");
    return path.endsWith("/") && !next.endsWith("/") ? `${next}/` : next;
  };
  if (before === file) {
    // A file that does not move: a path into a renamed folder follows it.
    const target = posix.normalize(posix.join(posix.dirname(file), path));
    if (target.startsWith("../") || !inAnyFrom(target)) return path;
    return write(posix.dirname(file), renamedPath(target));
  }
  // A file that moves: a path to a file outside its folder keeps its target.
  const bases = [[posix.dirname(file), posix.dirname(before)]];
  const folder = packageFolderOf(file);
  if (folder !== null) bases.push([folder, formerPath(folder)]);
  for (const [now, then] of bases) {
    const target = posix.normalize(posix.join(then, path));
    if (target.startsWith("../") || target === "..") continue;
    if (!existedBefore(target.replace(/\/$/, ""))) continue;
    return write(now, renamedPath(target));
  }
  return path;
}
function renameRelativePaths(file, text, pattern = RELATIVE_PATH) {
  return text.replace(pattern, (whole, ...groups) => {
    const isLink = pattern === MARKDOWN_LINK;
    const lead = isLink ? groups[0] : "";
    const target = isLink ? groups[1] : whole;
    if (isLink && /^[a-z][a-z0-9+.-]*:|^\//i.test(target)) return whole;
    const trimmed = trimmedPath(target);
    if (trimmed === "") return whole;
    const next = renamedRelative(file, trimmed);
    if (next === trimmed) return whole;
    relativeChanges.push(`${file}: ${trimmed} -> ${next}`);
    return lead + next + keepTail(target, trimmed);
  });
}

for (const path of tree) {
  if (UNREAD.some((pattern) => pattern.test(path))) continue;
  if (SELF_FOLDER.test(path) || BINARY.test(path)) continue;
  const text = original(path);
  if (text === null) continue;
  if (FROZEN.some((pattern) => pattern.test(path))) {
    if (!path.endsWith(".md")) continue;
    put(path, renameRelativePaths(path, text, MARKDOWN_LINK), "link");
    continue;
  }
  let next = text.replace(FROM_ROOT, (from) => renamedPath(from));
  if (next !== text) put(path, next, "path");
  if (path === DOC_LINKS_RATCHET) continue;
  next = renameRelativePaths(path, next);
  put(path, next, "relative path");
}

// 4. The keys of the doc-links ratchet: "<document> -> <link target>".
if (original(DOC_LINKS_RATCHET) !== null) {
  const ratchet = JSON.parse(textOf(DOC_LINKS_RATCHET));
  const next = {};
  for (const [key, count] of Object.entries(ratchet)) {
    const [document, target] = key.split(" -> ");
    const link =
      target === undefined ? target : renamedRelative(document, target);
    if (link !== target) {
      relativeChanges.push(`${document}: ${target} -> ${link}`);
    }
    next[target === undefined ? key : `${document} -> ${link}`] = count;
  }
  put(DOC_LINKS_RATCHET, `${JSON.stringify(next, null, 2)}\n`, "path");
}

// ---------------------------------------------------------------------------
// 5. The ratchets keep their order. No count changes.

if (pending.has(CLONES_RATCHET)) {
  put(
    CLONES_RATCHET,
    clonesBaselineAfterRename(JSON.parse(textOf(CLONES_RATCHET)), (key) =>
      faults.push(`${CLONES_RATCHET}: the rename gives two lines for ${key}`),
    ),
    "path",
  );
}
for (const path of [...pending.keys()]) {
  if (!ORDERED.test(path) || path === CLONES_RATCHET) continue;
  const ordered = keepOrder(
    JSON.parse(original(path)),
    JSON.parse(textOf(path)),
  );
  put(path, `${JSON.stringify(ordered, null, 2)}\n`, "path");
}

// 6. The text edits of the renames.
for (const { edits = [] } of FOLDER_RENAMES) {
  for (const edit of edits) {
    const text = textOf(edit.file);
    if (text === null) {
      faults.push(`${edit.file}: the rename edits it, and it does not exist`);
    } else if (text.includes(edit.replace)) {
      // Done by an earlier run.
    } else if (text.includes(edit.find)) {
      put(edit.file, text.split(edit.find).join(edit.replace), "config");
    } else {
      faults.push(
        `${edit.file}: the rename looks for this text, and the file does not have it:\n    ${edit.find}\n  Correct the edit in scripts/refactor-17/folder-renames.mjs (${edit.why}).`,
      );
    }
  }
}
stopOnFaults();

// ---------------------------------------------------------------------------
// 7. Prettier, for a file that was clean before this run.

let formatted = 0;
const leftUnformatted = [];
for (const [path, text] of [...pending]) {
  const result = await formatWhenClean(
    root,
    diskPath(path),
    original(path),
    text,
  );
  if (result.state === "unclean") leftUnformatted.push(path);
  if (result.state !== "formatted") continue;
  formatted += 1;
  put(path, result.text, "format");
}

// ---------------------------------------------------------------------------
// The local files that git ignores in an old folder. A checkout that pulls
// the rename keeps them there: `--move-local` moves them. `.dev.vars*` holds
// the local secrets and `.wrangler/` the local D1 and Durable Object state,
// so they move. pnpm install and the prepare step of the 1Password Worker
// write `node_modules/` and `.generated/` again in the new folder.

function localFiles() {
  const found = [];
  for (const { from } of FOLDER_RENAMES) {
    if (!existsSync(join(root, from))) continue;
    const entries = git(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--",
      from,
    )
      .split("\n")
      .filter((entry) => entry !== "" && entry !== `${from}/`);
    for (const entry of entries) {
      found.push({ entry, target: renamedPath(entry.replace(/\/$/, "")) });
    }
  }
  return found;
}
if (flag("--local-files") || flag("--move-local")) {
  const found = localFiles();
  if (found.length === 0)
    console.log("No local file is left in an old folder.");
  for (const { entry, target } of found) {
    const name = posix.basename(entry.replace(/\/$/, ""));
    const rebuilt = ["node_modules", ".generated"].includes(name);
    if (!flag("--move-local") || rebuilt) {
      console.log(
        `${entry}${rebuilt ? "  (a tool writes it again: delete it)" : `  -> ${target}`}`,
      );
      continue;
    }
    moveLocal(entry.replace(/\/$/, ""), target);
  }
  process.exit(0);
}

/** Moves a local file or folder; a folder joins a folder that exists. */
function moveLocal(from, to) {
  if (!existsSync(join(root, to))) {
    mkdirSync(join(root, posix.dirname(to)), { recursive: true });
    renameSync(join(root, from), join(root, to));
    console.log(`moved ${from} -> ${to}`);
    return;
  }
  const bothFolders =
    statSync(join(root, from)).isDirectory() &&
    statSync(join(root, to)).isDirectory();
  if (!bothFolders) {
    console.log(`${from}: ${to} exists, so it stays. Join the two by hand.`);
    return;
  }
  for (const name of readdirSync(join(root, from))) {
    moveLocal(`${from}/${name}`, `${to}/${name}`);
  }
}

// ---------------------------------------------------------------------------
// The report, and the change.

function groupOf(path) {
  if (waiting.has(path))
    return pending.has(path) ? "moved and changed" : "moved";
  if (FROZEN.some((pattern) => pattern.test(path)))
    return "frozen documents (links)";
  if (/\.md$/.test(path)) return "documents";
  if (ORDERED.test(path)) return "ratchets and the layer map";
  if (path.startsWith("scripts/")) return "repository scripts";
  if (
    /(^|\/)(package\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|knip\.json|\.jscpd\.json|eslint\.config\.mjs|\.gitignore)$/.test(
      path,
    )
  ) {
    return "configs";
  }
  return "other files";
}
const groups = {};
for (const path of new Set([...pending.keys(), ...waiting.keys()])) {
  const group = groupOf(path);
  groups[group] = (groups[group] ?? 0) + 1;
}
const rootPaths = [...pending.keys()].filter((path) =>
  kinds.get(path).has("path"),
).length;
console.log(
  `${FOLDER_RENAMES.map(({ from, to }) => `${from} -> ${to}`).join(", ")}: ${waiting.size} files to move, ${pending.size} files to write.`,
);
for (const [group, count] of Object.entries(groups).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`${String(count).padStart(6)}  ${group}`);
}
console.log(
  `${rootPaths} files with a path from the root, ${relativeChanges.length} relative paths changed. Prettier changed ${formatted} files; ${leftUnformatted.length} changed files were not clean before, so they keep their form.`,
);
for (const line of [...new Set(relativeChanges)].sort()) {
  if (!/\.md: /.test(line)) console.log(`  ${line}`);
}
if (option("--report") !== undefined) {
  writeFileSync(
    resolve(option("--report")),
    `${JSON.stringify(
      {
        moved: waiting.size,
        changed: pending.size,
        groups,
        rootPaths,
        formatted,
        notFormatted: leftUnformatted,
        relativeChanges: [...new Set(relativeChanges)].sort(),
        files: Object.fromEntries(
          [...pending.keys()]
            .sort()
            .map((path) => [path, [...kinds.get(path)]]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

const lockfile = existsSync(join(root, "pnpm-lock.yaml"))
  ? readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
  : "";
const lockfileOld = FOLDER_RENAMES.some(({ from }) =>
  new RegExp(`^  ${escaped(from)}:$`, "m").test(lockfile),
);

if (checkOnly) {
  if (lockfileOld) console.log("  would write pnpm-lock.yaml (pnpm install)");
  if (pending.size + waiting.size > 0 || lockfileOld) {
    for (const path of [...pending.keys()].sort().slice(0, 40)) {
      console.log(`  would write ${path} (${[...kinds.get(path)].join(", ")})`);
    }
    if (pending.size > 40) console.log(`  and ${pending.size - 40} more`);
    process.exit(1);
  }
  console.log("Nothing to change.");
  process.exit(0);
}

// 1. The moves. A folder whose new place does not exist moves whole, with
// the local files in it; else each file moves by itself.
for (const { from, to } of FOLDER_RENAMES) {
  const files = [...waiting].filter(([, old]) => inFolder(old, from));
  if (files.length === 0) continue;
  mkdirSync(join(root, posix.dirname(to)), { recursive: true });
  if (
    !existsSync(join(root, to)) &&
    files.every(([, old]) => trackedNow.has(old))
  ) {
    git("mv", from, to);
    continue;
  }
  for (const [next, old] of files) {
    mkdirSync(join(root, posix.dirname(next)), { recursive: true });
    if (trackedNow.has(old)) git("mv", old, next);
    else renameSync(join(root, old), join(root, next));
  }
}
for (const [path, text] of pending) {
  mkdirSync(join(root, posix.dirname(path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// 8. The lockfile names each workspace folder.
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
  if (lockfileOld)
    console.log("Run pnpm install: the lockfile names an old folder.");
} else if (lockfileOld || waiting.size > 0) {
  run("pnpm", ["install", "--prefer-offline"]);
}

if (flag("--stage")) {
  const written = [...pending.keys(), "pnpm-lock.yaml"].filter((path) =>
    existsSync(join(root, path)),
  );
  if (written.length > 0) git("add", "--", ...written);
}
const left = localFiles();
if (left.length > 0) {
  console.log(
    `${left.length} local files that git ignores are left in an old folder. List them with --local-files, and move them with --move-local.`,
  );
}
console.log(
  pending.size + waiting.size === 0
    ? "Nothing to change."
    : `Done in ${((Date.now() - started) / 1000).toFixed(1)} s. ${flag("--stage") ? "Each file of this run is staged." : "The moves are staged; stage the other files by path, or run with --stage."}`,
);

function stopOnFaults() {
  if (faults.length === 0) return;
  console.error([...new Set(faults)].join("\n"));
  console.error(`${faults.length} faults. Nothing is changed.`);
  process.exit(1);
}
