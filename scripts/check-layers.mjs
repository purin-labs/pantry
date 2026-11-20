#!/usr/bin/env node
// Fails when an import crosses the three layers the wrong way (Refactor 17,
// step A0.3).
//
// scripts/layers.json gives each source file a module in one of the layers:
// foundation, areas, surfaces, workers. An import may only go down:
//
//   workers -> surfaces -> areas -> foundation
//
// The check counts three kinds of crossing:
//   upward   a lower layer imports a higher one
//   areas    one area imports another area
//   order    a foundation module imports a foundation module that is later
//            in foundationOrder
//
// It reads the relative imports and the workspace package imports of each
// file under `covers`, and the workspace dependencies of each package.json in
// `packages`. scripts/layers-ratchet.json holds the known crossings by module
// pair. A pair may not grow, and a new pair is refused. Remove a crossing with
// a port: the lower module defines an interface, and the higher one gives the
// implementation. Then lower the baseline with --update.
//
// A file under `covers` with no module is refused: add a rule or a line to
// scripts/layers.json.
//
//   node scripts/check-layers.mjs                       check
//   node scripts/check-layers.mjs --update              lower entries, drop pairs that are gone
//   node scripts/check-layers.mjs --init                write the baseline from the current tree
//   node scripts/check-layers.mjs --report              print the totals and each pair
//   node scripts/check-layers.mjs --list "<a> -> <b>"   print the imports of one pair
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = "scripts/layers.json";
const BASELINE = "scripts/layers-ratchet.json";

const mode = process.argv[2] ?? "check";
if (!["check", "--update", "--init", "--report", "--list"].includes(mode)) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}

const targets = JSON.parse(readFileSync(join(root, TARGETS), "utf8"));
const layerRank = new Map(targets.layers.map((layer, index) => [layer, index]));
const orderRank = new Map(
  targets.foundationOrder.map((name, index) => [`foundation/${name}`, index]),
);
const rules = Object.entries(targets.rules).sort(
  ([a], [b]) => b.length - a.length,
);
const packageByName = new Map(
  Object.entries(targets.packages).map(([folder, module]) => [
    posix.basename(folder),
    module,
  ]),
);

const faults = [];

function moduleOf(path) {
  const exact = targets.files[path];
  if (exact !== undefined) return exact;
  for (const [prefix, module] of rules) {
    if (path.startsWith(prefix)) return module;
  }
  return null;
}

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

const tracked = execFileSync("git", ["ls-files", "--", ...targets.covers], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter(
    (path) =>
      /\.(ts|tsx)$/.test(path) &&
      !path.endsWith(".d.ts") &&
      !/\/generated\//.test(path) &&
      existsSync(join(root, path)),
  );
const known = new Set(tracked);

function resolveRelative(from, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const WORKSPACE = /^@[a-z0-9-]+\/([a-z0-9-]+)/;

/** pair -> { kind, count, sites } */
const found = new Map();

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
  const text = readFileSync(join(root, path), "utf8");
  IMPORT.lastIndex = 0;
  let match;
  while ((match = IMPORT.exec(text)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith(".")) {
      const target = resolveRelative(path, specifier);
      if (target === null) continue;
      const to = moduleOf(target);
      if (to !== null) record(from, to, `${path} -> ${target}`);
      continue;
    }
    const workspace = WORKSPACE.exec(specifier);
    const to = workspace === null ? undefined : packageByName.get(workspace[1]);
    if (to !== undefined) record(from, to, `${path} -> ${specifier}`);
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
    const kind = crossing(from, to);
    if (kind === null) continue;
    const pair = `package ${folder} -> ${dependency}`;
    found.set(pair, { kind, count: 1, sites: [`${folder}/package.json`] });
  }
}

function totals(entries) {
  const sum = { upward: 0, areas: 0, order: 0 };
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
    `files ${tracked.length} | upward ${sum.upward} | areas ${sum.areas} | order ${sum.order} | total ${sum.upward + sum.areas + sum.order}`,
  );
  for (const [pair, { kind, count }] of [...found].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(`${String(count).padStart(4)}  ${kind.padEnd(6)}  ${pair}`);
  }
  process.exit(faults.length === 0 ? 0 : 1);
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
    "An import may only go down the layers. Use a port: the lower module defines an interface, and the higher one gives the implementation. See docs/refactor-17.md.",
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
