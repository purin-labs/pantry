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
//   areas    one area imports a file of another area. An import of a workspace
//            package of another area is allowed: the package is the contract
//            of that area (step A1.10). A package of an area may depend on a
//            package of another area that `contracts` lists
//   order    a foundation module imports a foundation module that is later
//            in foundationOrder
//   table    a module writes a D1 table that another module owns
//
// It reads the relative imports and the workspace package imports of each
// file under `covers`, and the workspace dependencies of each package.json in
// `packages`. scripts/layers-ratchet.json holds the known crossings by module
// pair. A pair may not grow, and a new pair is refused. Remove a crossing with
// a port: the lower module defines an interface, and the higher one gives the
// implementation. Then lower the baseline with --update.
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
//   node scripts/check-layers.mjs --misfits [share] [links]
//       print each file whose imports and importers are mostly in another
//       module (default: a share of 0.6 and 4 links). Such a file has a wrong
//       line in scripts/layers.json, or it is a true crossing.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  importsOf,
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
  (targets.contracts ?? []).map((folder) => posix.basename(folder)),
);
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

const WORKSPACE = /^@[a-z0-9-]+\/([a-z0-9-]+)/;

/** pair -> { kind, count, sites } */
const found = new Map();
/** file -> { module: count } for the files that it imports and that import it */
const links = new Map();

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
  for (const specifier of importsOf(readFileSync(join(root, path), "utf8"))) {
    if (specifier.startsWith(".")) {
      const target = resolveRelative(path, specifier);
      if (target === null) continue;
      const to = moduleOf(target);
      if (to === null) continue;
      record(from, to, `${path} -> ${target}`);
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
    if (layerOf(from) === "areas" && layerOf(to) === "areas") continue;
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
// or DELETE FROM with the table name, in a file under `covers`.
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
  /\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update|delete\s+from)\s+"?([a-z0-9_]+)"?/gi;
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
  for (const [pair, { kind, count }] of [...found].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(`${String(count).padStart(4)}  ${kind.padEnd(6)}  ${pair}`);
  }
  process.exit(faults.length === 0 ? 0 : 1);
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

function writeBaseline(crossings) {
  const sum = totals(
    Object.entries(crossings).map(([pair, count]) => ({
      kind: found.get(pair).kind,
      count,
    })),
  );
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify({ totals: sum, crossings }, null, 2)}\n`,
  );
}

if (mode === "--init") {
  writeBaseline(current);
  console.log(`wrote ${BASELINE}: ${Object.keys(current).length} pairs`);
  process.exit(0);
}

const baseline = JSON.parse(
  readFileSync(join(root, BASELINE), "utf8"),
).crossings;
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
  process.exit(0);
}

if (grown.length > 0) {
  console.error(grown.join("\n"));
  console.error(
    "An import may only go down the layers. Use a port: the lower module defines an interface, and the higher one gives the implementation. Only the owner of a table writes it: call a function of the owner. See docs/refactor-17.md.",
  );
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
