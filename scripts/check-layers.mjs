#!/usr/bin/env node
// Fails when an import crosses the three layers the wrong way (Refactor 17,
// step A0.3).
//
// scripts/layers.json gives each source file a module in one of the layers:
// foundation, areas, surfaces, workers. An import may only go down:
//
//   workers -> surfaces -> areas -> foundation
//
// The check counts four kinds of crossing:
//   upward   a lower layer imports a higher one
//   areas    one area imports a file of another area that is not public. An
//            import of a workspace package of another area is allowed: the
//            package is the contract of that area. A package of an area may
//            depend on a package of another area that `contracts` lists
//   order    a foundation module imports a foundation module that is later
//            in foundationOrder
//   table    a module writes a D1 table that another module owns
//
// The contract of an area (step A1.10). `contracts` lists the public parts of
// the areas: a workspace package folder, or a source file or a source folder
// (with a final `/`) under `covers`. An import of a public source file from
// another area is not a crossing. A public file must be honest: it imports no
// file of its own area that is not public, except with `import type`, so the
// contract does not pull in the implementation. The check refuses a public
// file that does. A service whose code needs the inside of its area stays
// behind an interface that the Worker wires. --report gives the count of the
// imports between areas that go through a contract.
//
// It reads the relative imports and the workspace package imports of each
// file under `covers`, and the workspace dependencies of each package.json in
// `packages`. scripts/layers-ratchet.json holds the known crossings by module
// pair. A pair may not grow, and a new pair is refused. Remove a crossing with
// a port: the lower module defines an interface, and the higher one gives the
// implementation. Then lower the baseline with --update.
//
// Each pair that stays has a written reason: `reasons` in the same file gives
// the reason and the fix of each pair, and the check refuses a pair with no
// reason or no fix. --update drops the reason of a pair that is gone.
//
// A file under `covers` with no module is refused: add a rule or a line to
// scripts/layers.json. A tracked file outside `covers` needs a folder in
// `packages` or a prefix in `placement`, so that each file has a place in the
// target layout. A table of a D1 baseline needs an owner in `tables`.
//
//   node scripts/check-layers.mjs                       check
//   node scripts/check-layers.mjs --update              lower entries, drop pairs that are gone
//   node scripts/check-layers.mjs --init                write the baseline from the current tree
//   node scripts/check-layers.mjs --report              print the totals and each pair
//   node scripts/check-layers.mjs --list "<a> -> <b>"   print the imports of one pair
//   node scripts/check-layers.mjs --tables [--shared]   print the writer modules of each D1 table
//   node scripts/check-layers.mjs --areas [module]      print the files, tables and public files of each module
//   node scripts/check-layers.mjs --areas --write       write that list to docs/layers.md
//   node scripts/check-layers.mjs --areas --check       fail when docs/layers.md is older than the map
//   node scripts/check-layers.mjs --misfits [share] [links]
//       print each file whose imports and importers are mostly in another
//       module (default: a share of 0.6 and 4 links). Such a file has a wrong
//       line in scripts/layers.json, or it is a true crossing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  importStatementsOf,
  moduleOf,
  relativeResolver,
  root,
  targets,
  TARGETS,
  trackedFiles,
} from "./lib/layers.mjs";

const BASELINE = "scripts/layers-ratchet.json";

const mode = process.argv[2] ?? "check";
if (
  ![
    "check",
    "--update",
    "--init",
    "--report",
    "--list",
    "--tables",
    "--misfits",
    "--areas",
  ].includes(mode)
) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}

const layerRank = new Map(targets.layers.map((layer, index) => [layer, index]));
const orderRank = new Map(
  targets.foundationOrder.map((name, index) => [`foundation/${name}`, index]),
);
// The workspace packages that are the contract of their area. A package of
// another area may depend on them.
const contractPackages = new Set(
  (targets.contracts ?? [])
    .filter((path) => targets.packages[path] !== undefined)
    .map((folder) => posix.basename(folder)),
);
// The public source files and folders of the areas.
const publicPaths = (targets.contracts ?? []).filter(
  (path) => targets.packages[path] === undefined,
);
function isPublic(path) {
  return publicPaths.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}
const packageByName = new Map(
  Object.entries(targets.packages).map(([folder, module]) => [
    posix.basename(folder),
    module,
  ]),
);

const faults = [];

function layerOf(module) {
  return module.slice(0, module.indexOf("/"));
}

/** The kind of a crossing from one module to another, or null. */
function crossing(from, to) {
  if (from === to) return null;
  const fromLayer = layerOf(from);
  const toLayer = layerOf(to);
  if (layerRank.get(fromLayer) < layerRank.get(toLayer)) return "upward";
  if (fromLayer === "areas" && toLayer === "areas") return "areas";
  if (fromLayer === "foundation" && toLayer === "foundation") {
    const a = orderRank.get(from);
    const b = orderRank.get(to);
    if (a === undefined || b === undefined) {
      faults.push(
        `${TARGETS}: foundationOrder lacks ${a === undefined ? from : to}`,
      );
      return null;
    }
    return a < b ? "order" : null;
  }
  return null;
}

for (const module of [
  ...Object.values(targets.rules),
  ...Object.values(targets.files),
  ...Object.values(targets.packages),
]) {
  if (!layerRank.has(layerOf(module))) {
    faults.push(`${TARGETS}: ${module} names no layer`);
  }
}

const tracked = trackedFiles(...targets.covers).filter(
  (path) =>
    /\.(ts|tsx)$/.test(path) &&
    !path.endsWith(".d.ts") &&
    !/\/generated\//.test(path) &&
    existsSync(join(root, path)),
);
const resolveRelative = relativeResolver(new Set(tracked));

for (const entry of publicPaths) {
  if (!targets.covers.some((folder) => entry.startsWith(folder))) {
    faults.push(`${TARGETS}: contracts names ${entry}, which no cover holds`);
    continue;
  }
  const module = entry.endsWith("/")
    ? (tracked.filter((path) => path.startsWith(entry)).map(moduleOf)[0] ??
      null)
    : moduleOf(entry);
  if (module === null || layerOf(module) !== "areas") {
    faults.push(
      `${TARGETS}: contracts names ${entry}, which is not in an area`,
    );
  }
}

const WORKSPACE = /^@[a-z0-9-]+\/([a-z0-9-]+)/;

/** pair -> { kind, count, sites } */
const found = new Map();
/** file -> { module: count } for the files that it imports and that import it */
const links = new Map();
/** The imports between two areas that go through a contract. */
const throughContracts = { files: 0, packages: 0 };

function link(path, module) {
  const entry = links.get(path) ?? {};
  entry[module] = (entry[module] ?? 0) + 1;
  links.set(path, entry);
}

function record(from, to, site) {
  const kind = crossing(from, to);
  if (kind === null) return;
  const pair = `${from} -> ${to}`;
  const entry = found.get(pair) ?? { kind, count: 0, sites: [] };
  entry.count += 1;
  entry.sites.push(site);
  found.set(pair, entry);
}

for (const path of tracked) {
  const from = moduleOf(path);
  if (from === null) {
    faults.push(`${path}: no module. Add a rule or a line to ${TARGETS}.`);
    continue;
  }
  const publicFile = isPublic(path);
  for (const { specifier, typeOnly } of importStatementsOf(
    readFileSync(join(root, path), "utf8"),
  )) {
    if (specifier.startsWith(".")) {
      const target = resolveRelative(path, specifier);
      if (target === null) continue;
      const to = moduleOf(target);
      if (to === null) continue;
      const targetPublic = isPublic(target);
      if (publicFile && to === from && !targetPublic && !typeOnly) {
        faults.push(
          `${path}: a public file imports ${target}, a file of its area that is not public. Import a public file, use import type, or let the Worker wire the service.`,
        );
      }
      if (
        targetPublic &&
        from !== to &&
        layerOf(from) === "areas" &&
        layerOf(to) === "areas"
      ) {
        throughContracts.files += 1;
      } else {
        record(from, to, `${path} -> ${target}`);
      }
      if (target !== path) {
        link(path, to);
        link(target, from);
      }
      continue;
    }
    const workspace = WORKSPACE.exec(specifier);
    const to = workspace === null ? undefined : packageByName.get(workspace[1]);
    if (to === undefined) continue;
    // A workspace package of an area is the contract of that area: its
    // schemas, its model and its client. Another area may import it.
    if (layerOf(from) === "areas" && layerOf(to) === "areas") {
      if (from !== to) throughContracts.packages += 1;
      continue;
    }
    record(from, to, `${path} -> ${specifier}`);
  }
}

for (const [folder, from] of Object.entries(targets.packages)) {
  const manifest = join(root, folder, "package.json");
  if (!existsSync(manifest)) {
    faults.push(`${TARGETS}: ${folder} has no package.json`);
    continue;
  }
  const json = JSON.parse(readFileSync(manifest, "utf8"));
  for (const dependency of Object.keys({
    ...json.dependencies,
    ...json.devDependencies,
  })) {
    const workspace = WORKSPACE.exec(dependency);
    const to = workspace === null ? undefined : packageByName.get(workspace[1]);
    if (to === undefined) continue;
    if (
      layerOf(from) === "areas" &&
      layerOf(to) === "areas" &&
      contractPackages.has(workspace[1])
    )
      continue;
    const kind = crossing(from, to);
    if (kind === null) continue;
    const pair = `package ${folder} -> ${dependency}`;
    found.set(pair, { kind, count: 1, sites: [`${folder}/package.json`] });
  }
}

// Each tracked file has a place in the target layout. A placement key is a
// folder prefix, or `<folder>/*` for the files directly in a folder (`*` for
// the files of the root).
const homes = [
  ...targets.covers,
  ...Object.keys(targets.packages).map((folder) => `${folder}/`),
  ...Object.keys(targets.placement),
];
function hasHome(path) {
  const folder = path.includes("/") ? `${posix.dirname(path)}/` : "";
  return homes.some((home) =>
    home.endsWith("*") ? `${folder}*` === home : path.startsWith(home),
  );
}
const homeless = new Set();
for (const path of trackedFiles()) {
  if (hasHome(path)) continue;
  homeless.add(`${path.split("/").slice(0, -1).slice(0, 2).join("/")}/`);
}
for (const folder of homeless) {
  faults.push(`${folder}: no place. Add a prefix to placement in ${TARGETS}.`);
}
// `pnpm lint:lint-paths` checks that each placement key matches a file.

// The writers of each D1 table. A write is INSERT INTO, REPLACE INTO, UPDATE
// or DELETE FROM with the table name, in a file under `covers`. The keywords
// are in upper case, as in each SQL text of the repository, so a sentence
// such as "Could not update project access" is not a write.
const tables = new Map();
for (const database of ["global", "regional"]) {
  const sql = readFileSync(
    join(
      root,
      `services/platform/migrations-${database}/0001_current_schema.sql`,
    ),
    "utf8",
  );
  for (const match of sql.matchAll(
    /^create table (?:if not exists )?"?([a-z0-9_]+)"?/gim,
  )) {
    tables.set(match[1], { database, writers: {} });
  }
}
const WRITE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z0-9_]+)"?/g;
for (const path of tracked) {
  const from = moduleOf(path);
  if (from === null) continue;
  for (const match of readFileSync(join(root, path), "utf8").matchAll(WRITE)) {
    const table = tables.get(match[1].toLowerCase());
    if (table === undefined) continue;
    (table.writers[from] ??= []).push(path);
  }
}
for (const [name, { writers }] of tables) {
  const owner = targets.tables[name];
  if (owner === undefined) {
    faults.push(`table ${name}: no owner. Add it to tables in ${TARGETS}.`);
    continue;
  }
  for (const [module, sites] of Object.entries(writers)) {
    if (module === owner) continue;
    found.set(`table ${name} (${owner}) <- ${module}`, {
      kind: "table",
      count: sites.length,
      sites,
    });
  }
}
for (const name of Object.keys(targets.tables)) {
  if (!tables.has(name)) {
    faults.push(`${TARGETS}: tables names ${name}, which no baseline has`);
  }
}

const LAYERS_PAGE = "docs/layers.md";
const LAYERS_PAGE_HEAD = `# The modules of the three layers

This page is made by \`node scripts/check-layers.mjs --areas --write\` from
\`scripts/layers.json\` and the tracked files. Do not edit it. \`pnpm lint\`
fails when the page is older than the map or the files: after a new file, a
new table or a changed line of the map, write the page again. Each section is
one module, bottom-up: the foundation in its order, the areas, the surfaces
and the Workers ([Refactor 17](refactor-17.md)). "Files" gives the count of
the source files of the module and the folders that hold them, with the count
in each folder. "Packages" gives its workspace packages. "Tables" gives the D1
tables that the module owns; only the owner writes a table. "Public files"
gives the contract of an area: the files and folders that another area may
import. A module with no line for one of these has none.

`;

/** The files, packages, tables and public files of each module. */
function moduleList(only) {
  const modules = new Set([
    ...Object.values(targets.rules),
    ...Object.values(targets.files),
    ...Object.values(targets.packages),
    ...Object.values(targets.tables),
  ]);
  // The layers bottom-up, the foundation in its order, then by name.
  const order = (a, b) =>
    layerRank.get(layerOf(a)) - layerRank.get(layerOf(b)) ||
    (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0) ||
    (a < b ? -1 : 1);
  const selected = [...modules]
    .filter((module) => layerRank.has(layerOf(module)))
    .filter(
      (module) =>
        only === null || module === only || module === `areas/${only}`,
    )
    .sort(order);
  const sections = [];
  for (const module of selected) {
    const lines = [`## ${module}`, ""];
    const files = tracked.filter((path) => moduleOf(path) === module);
    if (files.length > 0) {
      const folders = new Map();
      for (const path of files) {
        const folder = `${posix.dirname(path)}/`;
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
      }
      lines.push(`- Files: ${files.length} in ${folders.size} folders`);
      for (const [folder, count] of [...folders].sort(([a], [b]) =>
        a < b ? -1 : 1,
      ))
        lines.push(`  - \`${folder}\` ${count}`);
    }
    const packages = Object.entries(targets.packages)
      .filter(([, owner]) => owner === module)
      .map(([folder]) => folder)
      .sort();
    if (packages.length > 0)
      lines.push(
        `- Packages: ${packages.map((folder) => `\`${folder}\``).join(", ")}`,
      );
    const owned = Object.entries(targets.tables)
      .filter(([, owner]) => owner === module)
      .map(([name]) => name)
      .sort();
    if (owned.length > 0)
      lines.push(
        `- Tables (${owned.length}): ${owned.map((name) => `\`${name}\``).join(", ")}`,
      );
    const contract = (targets.contracts ?? [])
      .filter((entry) =>
        targets.packages[entry] !== undefined
          ? targets.packages[entry] === module
          : entry.endsWith("/")
            ? tracked.some(
                (path) => path.startsWith(entry) && moduleOf(path) === module,
              )
            : moduleOf(entry) === module,
      )
      .sort();
    if (contract.length > 0)
      lines.push(
        `- Public files: ${contract.map((entry) => `\`${entry}\``).join(", ")}`,
      );
    sections.push(lines.join("\n"));
  }
  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}

function totals(entries) {
  const sum = { upward: 0, areas: 0, order: 0, table: 0 };
  for (const { kind, count } of entries) sum[kind] += count;
  return sum;
}

const current = Object.fromEntries(
  [...found]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([pair, { count }]) => [pair, count]),
);

if (mode === "--report") {
  const sum = totals(found.values());
  console.log(
    `files ${tracked.length} | upward ${sum.upward} | areas ${sum.areas} | order ${sum.order} | table ${sum.table} | total ${sum.upward + sum.areas + sum.order + sum.table}`,
  );
  console.log(
    `through contracts ${throughContracts.files + throughContracts.packages} | public files ${throughContracts.files} | area packages ${throughContracts.packages}`,
  );
  for (const [pair, { kind, count }] of [...found].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(`${String(count).padStart(4)}  ${kind.padEnd(6)}  ${pair}`);
  }
  if (faults.length > 0) console.error(faults.join("\n"));
  process.exit(faults.length === 0 ? 0 : 1);
}

if (mode === "--areas") {
  const option = process.argv[3];
  const text = moduleList(
    option === undefined || option.startsWith("--") ? null : option,
  );
  if (option === "--write" || option === "--check") {
    const page = `${LAYERS_PAGE_HEAD}${text}`;
    const path = join(root, LAYERS_PAGE);
    if (option === "--write") {
      writeFileSync(path, page);
      console.log(`wrote ${LAYERS_PAGE}`);
      process.exit(0);
    }
    if (!existsSync(path) || readFileSync(path, "utf8") !== page) {
      console.error(
        `${LAYERS_PAGE} is older than the map. Run node scripts/check-layers.mjs --areas --write.`,
      );
      process.exit(1);
    }
    console.log(`${LAYERS_PAGE} lists the map of today`);
    process.exit(0);
  }
  process.stdout.write(text);
  process.exit(text === "" ? 2 : 0);
}

if (mode === "--tables") {
  let shared = 0;
  for (const [name, { database, writers }] of [...tables].sort()) {
    const list = Object.entries(writers).sort(
      (a, b) => b[1].length - a[1].length,
    );
    if (list.length > 1) shared += 1;
    if (process.argv[3] === "--shared" && list.length < 2) continue;
    console.log(
      `${database.padEnd(8)} ${name.padEnd(44)} ${(targets.tables[name] ?? "no owner").padEnd(24)} ${list.map(([module, sites]) => `${module} ${sites.length}`).join(", ") || "no writer found"}`,
    );
  }
  console.log(
    `${tables.size} tables. ${shared} have writers in two or more modules.`,
  );
  process.exit(0);
}

if (mode === "--misfits") {
  // Every module imports these, so they say nothing about the place of a file.
  const neutral = new Set([
    "foundation/std",
    "foundation/kernel",
    "foundation/contracts",
  ]);
  const share = Number(process.argv[3] ?? 0.6);
  const least = Number(process.argv[4] ?? 4);
  let count = 0;
  for (const [path, entry] of [...links].sort()) {
    const own = moduleOf(path);
    const list = Object.entries(entry)
      .filter(([module]) => !neutral.has(module))
      .sort((a, b) => b[1] - a[1]);
    const total = list.reduce((sum, [, n]) => sum + n, 0);
    const [top, n] = list[0] ?? [];
    if (top === undefined || top === own) continue;
    if (n < least || n / total < share) continue;
    count += 1;
    console.log(
      `${path}\n    ${own} (${entry[own] ?? 0} links), but ${top} has ${n} of ${total}`,
    );
  }
  console.log(`${count} of ${tracked.length} files.`);
  process.exit(0);
}

if (mode === "--list") {
  const entry = found.get(process.argv[3] ?? "");
  if (entry === undefined) {
    console.error(`no crossing "${process.argv[3] ?? ""}"`);
    process.exit(2);
  }
  console.log(entry.sites.join("\n"));
  process.exit(0);
}

if (faults.length > 0) {
  console.error(faults.join("\n"));
  process.exit(1);
}

const stored = existsSync(join(root, BASELINE))
  ? JSON.parse(readFileSync(join(root, BASELINE), "utf8"))
  : { crossings: {}, reasons: {} };
/** pair -> { reason, fix }: why a crossing stays, and what removes it. */
const reasons = stored.reasons ?? {};

function writeBaseline(crossings) {
  const sum = totals(
    Object.entries(crossings).map(([pair, count]) => ({
      kind: found.get(pair).kind,
      count,
    })),
  );
  const kept = Object.fromEntries(
    Object.keys(crossings)
      .filter((pair) => reasons[pair] !== undefined)
      .map((pair) => [pair, reasons[pair]]),
  );
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify({ totals: sum, crossings, reasons: kept }, null, 2)}\n`,
  );
}

/** The pairs of `crossings` with no reason or no fix. */
function unexplained(crossings) {
  return Object.keys(crossings)
    .filter(
      (pair) =>
        typeof reasons[pair]?.reason !== "string" ||
        reasons[pair].reason.trim() === "" ||
        typeof reasons[pair]?.fix !== "string" ||
        reasons[pair].fix.trim() === "",
    )
    .map(
      (pair) =>
        `${pair}: no written reason. Add { "reason": "...", "fix": "..." } for it under reasons in ${BASELINE}.`,
    );
}

if (mode === "--init") {
  writeBaseline(current);
  console.log(`wrote ${BASELINE}: ${Object.keys(current).length} pairs`);
  process.exit(0);
}

const baseline = stored.crossings;
const grown = [];
for (const [pair, count] of Object.entries(current)) {
  const allowed = baseline[pair];
  if (allowed === undefined) {
    grown.push(
      `${pair}: a new ${found.get(pair).kind} crossing (${count}). First site: ${found.get(pair).sites[0]}`,
    );
  } else if (count > allowed) {
    grown.push(
      `${pair}: ${count} imports, the baseline allows ${allowed}. Run --list "${pair}" to see them.`,
    );
  }
}

if (mode === "--update") {
  if (grown.length > 0) {
    console.error(grown.join("\n"));
    console.error("A crossing grew, so the baseline is not changed.");
    process.exit(1);
  }
  writeBaseline(current);
  console.log(`wrote ${BASELINE}: ${Object.keys(current).length} pairs`);
  const missing = unexplained(current);
  if (missing.length > 0) {
    console.error(missing.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

if (grown.length > 0) {
  console.error(grown.join("\n"));
  console.error(
    "An import may only go down the layers. Use a port: the lower module defines an interface, and the higher one gives the implementation. Only the owner of a table writes it: call a function of the owner. See docs/refactor-17.md.",
  );
  process.exit(1);
}
const stale = Object.keys(reasons).filter(
  (pair) => current[pair] === undefined,
);
const missing = [
  ...unexplained(current),
  ...stale.map(
    (pair) =>
      `${pair}: a reason for a crossing that is gone. Run node scripts/check-layers.mjs --update.`,
  ),
];
if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
const lower = Object.entries(baseline).filter(
  ([pair, allowed]) => (current[pair] ?? 0) < allowed,
);
if (lower.length > 0) {
  console.log(
    `${lower.length} pairs are below their baseline. Run node scripts/check-layers.mjs --update.`,
  );
}
