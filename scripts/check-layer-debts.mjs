#!/usr/bin/env node
// Holds the kinds of layer crossing that scripts/check-layers.mjs does not
// count (Refactor 17, "The layer check: what it does not count").
//
// scripts/check-layers.mjs counts the imports between the files of the map,
// the dependencies of each package.json and the D1 writes with a literal table
// name. A crossing can take another form. This check counts each such form,
// and scripts/layer-debts-ratchet.json holds the counts. A count may not grow,
// and a new key is refused. The check fixes no crossing: it makes each kind
// visible and stops its growth.
//
// The kinds:
//   env-merge           a `declare module` block in a file of one module that
//                       adds members to a file or a package of a module that
//                       may not import it: a Worker or Actor class in `Env`,
//                       the commerce types in a foundation record. `methods`
//                       counts, by name, the methods of such a class that a
//                       module below its declaration calls
//   foundation-misfit   a foundation file whose imports and importers are
//                       mostly in one area or one surface (`links`, the rule
//                       of check-layers.mjs --misfits), and a foundation file
//                       whose path names an area or a surface (`names`)
//   table-read          a FROM or JOIN read of a D1 table whose owner module
//                       the reader may not import
//   surface-nonpublic   a surface import of an area file that is not public
//   area-package        an import, from another area, of an area workspace
//                       package that `contracts` does not list
//   worker-logic        the files and the lines of a Worker module that are
//                       not the entry (a default export), not a class shell
//                       (a class declaration) and not wiring (no `if`, `for`,
//                       `while` or `switch` statement)
//   shopify-rule        an import of the Shopify module from outside it. One
//                       way is allowed: a Worker file imports a value that
//                       implements a port, which is an exported constant with
//                       a type from a public file of another area
//   interpolated-table  a write to a D1 or Actor SQLite table whose name is
//                       not a literal, so no check can read its owner
//   portal-default      a file whose module comes only from the rule of a
//                       whole covered folder, so a new file there is never
//                       refused
//
// The check reads the files, the modules, the packages, the public files and
// the tables only from scripts/layers.json, through scripts/lib/layers.mjs. It
// names no source folder, and each key of the ratchet is a module or a package
// name, not a path. An import by package name of a file under `covers` counts
// as the same import by a relative path. So a move of files to another folder
// or into a workspace package keeps each count, when the map moves with it.
//
// Each kind has a written reason and a fix in the ratchet file, and the check
// refuses a kind with none. A count goes up only by hand in that file: the
// review of that line is the decision to accept one more crossing.
//
//   node scripts/check-layer-debts.mjs                   check
//   node scripts/check-layer-debts.mjs --update          lower counts, drop keys that are gone
//   node scripts/check-layer-debts.mjs --init            write the counts of the current tree
//   node scripts/check-layer-debts.mjs --report          print the totals and each key
//   node scripts/check-layer-debts.mjs --report <kind>   print the instances of one kind
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  coveredSourceFiles,
  crossingKind,
  importStatementsOf,
  isPublic,
  keysWithoutReason,
  layerOf,
  linkCounter,
  moduleOf,
  relativeResolver,
  root,
  targets,
} from "./lib/layers.mjs";

const BASELINE = "scripts/layer-debts-ratchet.json";
const SCRIPT = "scripts/check-layer-debts.mjs";

const KINDS = [
  "env-merge",
  "foundation-misfit",
  "table-read",
  "surface-nonpublic",
  "area-package",
  "worker-logic",
  "shopify-rule",
  "interpolated-table",
  "portal-default",
];

const mode = process.argv[2] ?? "check";
if (!["check", "--update", "--init", "--report"].includes(mode)) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}

// --- The map -----------------------------------------------------------

/**
 * True when `from` may not import `to`: the rule of scripts/check-layers.mjs
 * for an import between two modules.
 */
function mayNotImport(from, to) {
  return crossingKind(from, to) !== null;
}

const tracked = coveredSourceFiles();
const known = new Set(tracked);
const resolveRelative = relativeResolver(known);
const texts = new Map(
  tracked.map((path) => [path, readFileSync(join(root, path), "utf8")]),
);

// --- The workspace packages -------------------------------------------

/** name -> { folder, module, name, exports, contract } */
const packagesByName = new Map();
/** The last part of the folder -> the package, as check-layers.mjs reads it. */
const packagesByFolderName = new Map();
for (const [folder, module] of Object.entries(targets.packages)) {
  const manifestPath = join(root, folder, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = {
    folder,
    module,
    name: manifest.name ?? folder,
    exports: manifest.exports ?? null,
    contract: (targets.contracts ?? []).includes(folder),
  };
  packagesByName.set(entry.name, entry);
  packagesByFolderName.set(posix.basename(folder), entry);
}

const WORKSPACE = /^(@[a-z0-9-]+\/([a-z0-9-]+))(\/.*)?$/;

/** The file of a package that a subpath names, from its `exports` map. */
function packageFile(entry, subpath) {
  const candidates = [];
  const exportsMap =
    entry.exports !== null && typeof entry.exports === "object"
      ? entry.exports
      : typeof entry.exports === "string"
        ? { ".": entry.exports }
        : {};
  for (const [key, value] of Object.entries(exportsMap)) {
    const target =
      typeof value === "string"
        ? value
        : (value?.default ?? value?.import ?? value?.types);
    if (typeof target !== "string") continue;
    if (key === subpath) candidates.push(target);
    else if (key.includes("*")) {
      const [head, tail] = key.split("*");
      if (
        subpath.startsWith(head) &&
        subpath.endsWith(tail) &&
        subpath.length >= head.length + tail.length
      ) {
        const middle = subpath.slice(head.length, subpath.length - tail.length);
        candidates.push(target.replace("*", middle));
      }
    }
  }
  // A package with no `exports` map: the subpath is a path in its folder.
  candidates.push(subpath, `./src/${subpath.slice(2)}`);
  for (const candidate of candidates) {
    const base = posix.normalize(posix.join(entry.folder, candidate));
    for (const path of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]) {
      if (known.has(path)) return path;
    }
  }
  return null;
}

/**
 * The target of an import: `file` when it is a file under `covers`, `package`
 * when the specifier names a workspace package, and its module. Null for an
 * import that the map does not hold.
 */
function resolveImport(path, specifier) {
  if (specifier.startsWith(".")) {
    const file = resolveRelative(path, specifier);
    const module = file === null ? null : moduleOf(file);
    return module === null ? null : { file, module, package: null };
  }
  const match = WORKSPACE.exec(specifier);
  if (match === null) return null;
  const entry =
    packagesByName.get(match[1]) ?? packagesByFolderName.get(match[2]);
  if (entry === undefined) return null;
  const file = packageFile(entry, `.${match[3] ?? ""}`);
  return {
    file,
    module: (file === null ? null : moduleOf(file)) ?? entry.module,
    package: entry,
  };
}

/** file -> [{ specifier, target }] for the imports that the map holds */
const imports = new Map();
for (const path of tracked) {
  const list = [];
  for (const { specifier } of importStatementsOf(texts.get(path))) {
    const target = resolveImport(path, specifier);
    if (target !== null) list.push({ specifier, target });
  }
  imports.set(path, list);
}

// --- The instances ----------------------------------------------------

/** kind -> key -> { count, sites } */
const found = new Map(KINDS.map((kind) => [kind, new Map()]));

function record(kind, key, site, weight = 1) {
  const keys = found.get(kind);
  const entry = keys.get(key) ?? { count: 0, sites: [] };
  entry.count += weight;
  entry.sites.push(site);
  keys.set(key, entry);
}

function lineOf(text, index) {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index;) {
    line += 1;
    at = text.indexOf("\n", at + 1);
  }
  return line;
}

// env-merge: a `declare module` block that adds members to a lower module.
const MERGE = /^declare\s+module\s+["']([^"']+)["']\s*\{/gm;
/** The classes that a counted merge binds: { name, file } */
const mergedClasses = [];
for (const path of tracked) {
  const text = texts.get(path);
  if (!text.includes("declare module")) continue;
  const from = moduleOf(path);
  if (from === null) continue;
  for (const match of text.matchAll(MERGE)) {
    const target = resolveImport(path, match[1]);
    if (target === null || !mayNotImport(target.module, from)) continue;
    record(
      "env-merge",
      `merges ${from} -> ${target.module}`,
      `${path}:${lineOf(text, match.index)} -> ${match[1]}`,
    );
    const end = text.indexOf("\n}", match.index);
    const block = text.slice(match.index, end === -1 ? undefined : end);
    for (const bound of block.matchAll(/<([A-Z]\w*)>/g)) {
      mergedClasses.push({ name: bound[1], file: path });
    }
  }
}

// env-merge, methods: the methods of a merged class that a module below the
// declaration calls. The check reads no types, so this count goes by name and
// leaves out each doubtful name. A method counts when:
//   - one file of the merged classes declares it, and no other;
//   - no file outside those classes declares a member with its name. A module
//     that declares the RPC interface of its part takes its methods out of
//     the count, and that is the fix;
//   - a file of a module that may not import the declaring file holds
//     `.name(`.
// One method counts one time for each caller module.
const HANDLERS = new Set([
  "constructor",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);
const MEMBER = /^ {2}(?:async\s+)?([a-zA-Z_]\w*)\s*(?:<[^>\n]*>)?\(/gm;

/** The body of the class `name` in `file`, and the class that it extends. */
function classIn(file, name) {
  const text = texts.get(file);
  const start = new RegExp(
    `^(?:export\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`,
    "m",
  ).exec(text);
  if (start === null) return null;
  const end = text.indexOf("\n}", start.index);
  const body = text.slice(start.index, end === -1 ? undefined : end);
  const base = /\bextends\s+([A-Za-z_]\w*)/.exec(
    body.slice(0, body.indexOf("{")),
  );
  return { body, base: base === null ? null : base[1] };
}

/** The file that declares the class `name`, seen from `file`. */
function declaringFile(file, name) {
  if (classIn(file, name) !== null) return file;
  const clause = new RegExp(
    `import\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`,
  ).exec(texts.get(file));
  if (clause === null) return null;
  const target = resolveImport(file, clause[1]);
  return target?.file != null && classIn(target.file, name) !== null
    ? target.file
    : null;
}

/** method name -> the files of the merged classes that declare it */
const mergedMethods = new Map();
const classFiles = new Set();
for (const { name, file } of mergedClasses) {
  let at = declaringFile(file, name);
  let className = name;
  for (let depth = 0; at !== null && depth < 12; depth += 1) {
    const declared = classIn(at, className);
    if (declared === null) break;
    classFiles.add(at);
    for (const member of declared.body.matchAll(MEMBER)) {
      if (HANDLERS.has(member[1])) continue;
      const files = mergedMethods.get(member[1]) ?? new Set();
      files.add(at);
      mergedMethods.set(member[1], files);
    }
    if (declared.base === null) break;
    className = declared.base;
    at = declaringFile(at, className);
  }
}
/** method name -> the module of the one file that declares it */
const methodModule = new Map(
  [...mergedMethods]
    .filter(([, files]) => files.size === 1)
    .map(([name, files]) => [name, moduleOf([...files][0])]),
);
if (methodModule.size > 0) {
  const names = [...methodModule.keys()].join("|");
  // A member with the same name outside the classes: `name(…) {`, `name(…):`,
  // `name:`, `name?:` or `name =` at the start of a line.
  const DECLARED = new RegExp(
    `^\\s+(?:readonly\\s+|async\\s+)*(${names})\\??\\s*(?:<[^>\\n]*>)?(?::|=[^=>]|\\([^)]*\\)\\s*(?::|\\{))`,
    "gm",
  );
  for (const [path, text] of texts) {
    if (classFiles.has(path)) continue;
    for (const match of text.matchAll(DECLARED)) methodModule.delete(match[1]);
  }
}
if (methodModule.size > 0) {
  const CALLED = new RegExp(
    `\\.(${[...methodModule.keys()].join("|")})\\(`,
    "g",
  );
  for (const [path, text] of texts) {
    const from = moduleOf(path);
    if (from === null) continue;
    const seen = new Set();
    for (const match of text.matchAll(CALLED)) {
      const module = methodModule.get(match[1]);
      if (seen.has(match[1]) || !mayNotImport(from, module)) continue;
      seen.add(match[1]);
      record(
        "env-merge",
        `methods ${from} -> ${module}`,
        `${match[1]} ${path}:${lineOf(text, match.index)}`,
      );
    }
  }
  for (const [key, entry] of found.get("env-merge")) {
    if (!key.startsWith("methods ")) continue;
    entry.count = new Set(entry.sites.map((site) => site.split(" ")[0])).size;
  }
}

// foundation-misfit, links: the rule of check-layers.mjs --misfits, for a
// foundation file whose links are mostly in one area or one surface.
const NEUTRAL = new Set([
  "foundation/std",
  "foundation/kernel",
  "foundation/contracts",
]);
const MISFIT_SHARE = 0.6;
const MISFIT_LINKS = 4;
/** file -> { module: count } for the files that it imports and that import it */
const { links, link } = linkCounter();
for (const [path, list] of imports) {
  const from = moduleOf(path);
  if (from === null) continue;
  for (const { target } of list) {
    if (target.file === null || target.file === path) continue;
    link(path, target.module);
    link(target.file, from);
  }
}
for (const [path, entry] of [...links].sort()) {
  const own = moduleOf(path);
  if (own === null || layerOf(own) !== "foundation") continue;
  const list = Object.entries(entry)
    .filter(([module]) => !NEUTRAL.has(module))
    .sort((a, b) => b[1] - a[1]);
  const total = list.reduce((sum, [, count]) => sum + count, 0);
  const [top, count] = list[0] ?? [];
  if (top === undefined || top === own) continue;
  if (count < MISFIT_LINKS || count / total < MISFIT_SHARE) continue;
  if (!["areas", "surfaces"].includes(layerOf(top))) continue;
  record(
    "foundation-misfit",
    `links ${own}`,
    `${path}: ${top} has ${count} of ${total} links`,
  );
}

// foundation-misfit, names: a foundation file whose path holds a word for an
// area or a surface. A list holds the name of the module in the map and the
// names that the code uses for that module. A word with a second meaning in
// the foundation is in no list: "organisation", "portal", "menu" and "order".
// The path is read below its covered folder, so the folder of a package or of
// a layer adds no word.
const WORDS = {
  "areas/brain": ["brain", "memory", "evals"],
  "areas/cafe": ["cafe"],
  "areas/commerce": ["commerce", "stripe", "payout", "payouts", "checkout"],
  "areas/devices": ["devices", "device"],
  "areas/inbox": ["inbox", "mailbox"],
  "areas/integrations": ["integrations", "jev", "typesafe"],
  "areas/kitchen": ["kitchen", "bakery", "bake", "recipe", "recipes"],
  "areas/organisation": ["onboarding", "billing"],
  "areas/shopify": ["shopify"],
  "surfaces/email": ["email", "mail", "gmail"],
  "surfaces/slack": ["slack"],
  "surfaces/voice": ["voice"],
  "surfaces/webhooks": ["webhooks", "webhook"],
  "surfaces/whatsapp": ["whatsapp"],
};
const wordOwner = new Map(
  Object.entries(WORDS).flatMap(([module, words]) =>
    words.map((word) => [word, module]),
  ),
);
/** The path of a file below the covered folder that holds it. */
function pathInCover(path) {
  const cover = targets.covers
    .filter((folder) => path.startsWith(folder))
    .sort((a, b) => b.length - a.length)[0];
  return cover === undefined ? path : path.slice(cover.length);
}
for (const path of tracked) {
  const own = moduleOf(path);
  if (own === null || layerOf(own) !== "foundation") continue;
  const word = pathInCover(path)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((part) => wordOwner.has(part));
  if (word === undefined) continue;
  record(
    "foundation-misfit",
    `names ${own}`,
    `${path}: "${word}" names ${wordOwner.get(word)}`,
  );
}

// table-read: a read of a table that a module above the reader owns, or
// another area. The keywords are in upper case, as in each SQL text.
const READ = /(?<!DELETE\s+)\b(?:FROM|JOIN)\s+"?([a-z0-9_]+)"?/g;
for (const path of tracked) {
  const from = moduleOf(path);
  if (from === null) continue;
  const text = texts.get(path);
  for (const match of text.matchAll(READ)) {
    const owner = targets.tables[match[1]];
    if (owner === undefined || !mayNotImport(from, owner)) continue;
    record(
      "table-read",
      `reads ${from} -> ${owner}`,
      `${path}:${lineOf(text, match.index)} ${match[1]}`,
    );
  }
}

// surface-nonpublic and area-package.
for (const [path, list] of imports) {
  const from = moduleOf(path);
  if (from === null) continue;
  for (const { specifier, target } of list) {
    if (
      layerOf(from) === "surfaces" &&
      target.file !== null &&
      layerOf(target.module) === "areas" &&
      !isPublic(target.file)
    ) {
      record(
        "surface-nonpublic",
        `imports ${from} -> ${target.module}`,
        `${path} -> ${target.file}`,
      );
    }
    if (
      layerOf(from) === "areas" &&
      target.package !== null &&
      layerOf(target.package.module) === "areas" &&
      target.package.module !== from &&
      !target.package.contract &&
      !(target.file !== null && isPublic(target.file))
    ) {
      record(
        "area-package",
        `imports ${from} -> ${target.package.name}`,
        `${path} -> ${specifier}`,
      );
    }
  }
}

// worker-logic: the files of a Worker module that hold logic.
const BRANCH = /^\s*(?:\}\s*else\s+)?(?:if|for|while|switch)\s*\(/m;
for (const path of tracked) {
  const module = moduleOf(path);
  if (module === null || layerOf(module) !== "workers") continue;
  const text = texts.get(path);
  if (/^export\s+default\b/m.test(text)) continue; // the entry
  if (/^(?:export\s+)?(?:abstract\s+)?class\s+\w/m.test(text)) continue; // a class shell
  if (!BRANCH.test(text)) continue; // wiring
  const lines = text.split("\n").length - 1;
  record("worker-logic", `files ${module}`, `${path}: ${lines} lines`);
  record("worker-logic", `lines ${module}`, `${path}: ${lines} lines`, lines);
}

// shopify-rule: the imports of the Shopify module from outside it.
const SHOPIFY = "areas/shopify";
const CLAUSE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
/** The names of an import clause: [imported, local] */
function clauseNames(clause) {
  return clause
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part !== "")
    .map((part) => part.split(/\s+as\s+/));
}
const portValues = new Map();
/** The exported constants of a file with a type from a public file of another area. */
function portValuesOf(file) {
  const cached = portValues.get(file);
  if (cached !== undefined) return cached;
  const text = texts.get(file);
  const own = moduleOf(file);
  const portTypes = new Set();
  for (const match of text.matchAll(CLAUSE)) {
    const target = resolveImport(file, match[2]);
    if (target?.file == null || target.module === own) continue;
    if (!isPublic(target.file)) continue;
    for (const names of clauseNames(match[1])) portTypes.add(names.at(-1));
  }
  const values = new Set();
  for (const match of text.matchAll(/^export const (\w+):\s*(\w+)\b/gm)) {
    if (portTypes.has(match[2])) values.add(match[1]);
  }
  portValues.set(file, values);
  return values;
}
for (const [path, list] of imports) {
  const from = moduleOf(path);
  if (from === null || from === SHOPIFY) continue;
  const text = texts.get(path);
  for (const { specifier, target } of list) {
    if (target.file === null || target.module !== SHOPIFY) continue;
    const statements = list.filter((entry) => entry.specifier === specifier);
    const clauses = [...text.matchAll(CLAUSE)].filter(
      (match) => match[2] === specifier,
    );
    const ports = portValuesOf(target.file);
    const registration =
      layerOf(from) === "workers" &&
      clauses.length === statements.length &&
      clauses.every((match) =>
        clauseNames(match[1]).every(([imported]) => ports.has(imported)),
      );
    if (registration) continue;
    record(
      "shopify-rule",
      `imports ${from} -> ${SHOPIFY}`,
      `${path} -> ${target.file}`,
    );
  }
}

// interpolated-table: a write whose table name is `${…}`. No rule tells a
// D1 write from an Actor SQLite write, so the count holds both.
const INTERPOLATED =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?\$\{/g;
for (const path of tracked) {
  const module = moduleOf(path);
  if (module === null) continue;
  const text = texts.get(path);
  for (const match of text.matchAll(INTERPOLATED)) {
    record(
      "interpolated-table",
      `writes ${module}`,
      `${path}:${lineOf(text, match.index)}`,
    );
  }
}

// portal-default: a file with no line of its own, under the rule of a whole
// covered folder.
const ruleKeys = Object.keys(targets.rules).sort((a, b) => b.length - a.length);
for (const path of tracked) {
  if (targets.files[path] !== undefined) continue;
  const rule = ruleKeys.find((prefix) => path.startsWith(prefix));
  if (rule === undefined || !targets.covers.includes(rule)) continue;
  record("portal-default", `files ${targets.rules[rule]}`, path);
}

// --- The ratchet ------------------------------------------------------

/** kind -> { unit: sum } */
function totalsOf(counts) {
  const totals = {};
  for (const [kind, keys] of Object.entries(counts)) {
    const units = {};
    for (const [key, count] of Object.entries(keys)) {
      const unit = key.slice(0, key.indexOf(" "));
      units[unit] = (units[unit] ?? 0) + count;
    }
    totals[kind] = units;
  }
  return totals;
}

function summary(units) {
  return Object.entries(units)
    .map(([unit, count]) => `${count} ${unit}`)
    .join(", ");
}

const current = Object.fromEntries(
  KINDS.map((kind) => [
    kind,
    Object.fromEntries(
      [...found.get(kind)]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, { count }]) => [key, count]),
    ),
  ]).filter(([, keys]) => Object.keys(keys).length > 0),
);

if (mode === "--report") {
  const kind = process.argv[3];
  if (kind === undefined) {
    for (const [name, units] of Object.entries(totalsOf(current))) {
      console.log(`${name}: ${summary(units)}`);
      for (const [key, count] of Object.entries(current[name])) {
        console.log(`${String(count).padStart(6)}  ${key}`);
      }
    }
    process.exit(0);
  }
  if (!KINDS.includes(kind)) {
    console.error(`no kind "${kind}". The kinds: ${KINDS.join(", ")}`);
    process.exit(2);
  }
  for (const [key, { count, sites }] of [...found.get(kind)].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    console.log(`${key}: ${count}`);
    for (const site of sites) console.log(`    ${site}`);
  }
  process.exit(0);
}

const stored = existsSync(join(root, BASELINE))
  ? JSON.parse(readFileSync(join(root, BASELINE), "utf8"))
  : { kinds: {} };
const storedKinds = stored.kinds ?? {};

function writeBaseline(counts) {
  const kinds = Object.fromEntries(
    Object.entries(counts).map(([kind, keys]) => [
      kind,
      {
        reason: storedKinds[kind]?.reason ?? "",
        fix: storedKinds[kind]?.fix ?? "",
        counts: keys,
      },
    ]),
  );
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify({ totals: totalsOf(counts), kinds }, null, 2)}\n`,
  );
}

/** The kinds of `counts` with no reason or no fix. */
function unexplained(counts) {
  return keysWithoutReason(Object.keys(counts), storedKinds).map(
    (kind) =>
      `${kind}: no written reason. Add "reason" and "fix" for it under kinds in ${BASELINE}.`,
  );
}

if (mode === "--init") {
  writeBaseline(current);
  console.log(`wrote ${BASELINE}: ${Object.keys(current).length} kinds`);
  const missing = unexplained(current);
  if (missing.length > 0) {
    console.error(missing.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

const grown = [];
const grownKinds = new Set();
let lower = 0;
for (const [kind, keys] of Object.entries(current)) {
  const allowed = storedKinds[kind]?.counts ?? {};
  for (const [key, count] of Object.entries(keys)) {
    if (allowed[key] === undefined) {
      grown.push(
        `${kind}: a new key "${key}" (${count}). First site: ${found.get(kind).get(key).sites[0]}`,
      );
      grownKinds.add(kind);
    } else if (count > allowed[key]) {
      grown.push(
        `${kind}: "${key}" is ${count}, the baseline allows ${allowed[key]}. Run node ${SCRIPT} --report ${kind} to see each one.`,
      );
      grownKinds.add(kind);
    } else if (count < allowed[key]) lower += 1;
  }
}
for (const [kind, { counts }] of Object.entries(storedKinds)) {
  for (const key of Object.keys(counts ?? {})) {
    if (current[kind]?.[key] === undefined) lower += 1;
  }
}

if (grown.length > 0) {
  console.error(grown.join("\n"));
  for (const kind of grownKinds) {
    const fix = storedKinds[kind]?.fix;
    if (typeof fix === "string" && fix !== "") {
      console.error(`The fix for ${kind}: ${fix}`);
    }
  }
  console.error(
    `A kind of layer crossing that the layer check does not count grew. ${BASELINE} gives the reason and the fix of each kind. A count goes up only by hand in that file, with a decision of the owner.`,
  );
  if (mode === "--update") {
    console.error("A count grew, so the baseline is not changed.");
  }
  process.exit(1);
}

if (mode === "--update") {
  writeBaseline(current);
  console.log(`wrote ${BASELINE}: ${Object.keys(current).length} kinds`);
}

const missing = unexplained(current);
if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
if (mode === "check") {
  if (lower > 0) {
    console.log(
      `${lower} counts are below their baseline. Run node ${SCRIPT} --update.`,
    );
  }
  console.log(
    `layer debts, none grew: ${Object.entries(totalsOf(current))
      .map(([kind, units]) => `${kind} ${summary(units)}`)
      .join("; ")}`,
  );
}
