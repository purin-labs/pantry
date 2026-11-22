// Shared by scripts/check-layers.mjs, scripts/check-layer-debts.mjs and
// scripts/list-tests.mjs: the module of a file from scripts/layers.json, the
// rule for an import between two modules, and the imports of a source file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const TARGETS = "scripts/layers.json";
export const targets = JSON.parse(readFileSync(join(root, TARGETS), "utf8"));

const rules = Object.entries(targets.rules).sort(
  ([a], [b]) => b.length - a.length,
);

/** The module of a file: its line in `files`, or the longest rule. */
export function moduleOf(path) {
  const exact = targets.files[path];
  if (exact !== undefined) return exact;
  for (const [prefix, module] of rules) {
    if (path.startsWith(prefix)) return module;
  }
  return null;
}

const packageFolders = Object.entries(targets.packages).sort(
  ([a], [b]) => b.length - a.length,
);

/** The module of a file, also for a file of a workspace package. */
export function moduleOrPackageOf(path) {
  return (
    moduleOf(path) ??
    packageFolders.find(([folder]) => path.startsWith(`${folder}/`))?.[1] ??
    null
  );
}

const layerRank = new Map(targets.layers.map((layer, index) => [layer, index]));
const orderRank = new Map(
  targets.foundationOrder.map((name, index) => [`foundation/${name}`, index]),
);

/** The layer of a module: the part of its name before the first slash. */
export function layerOf(module) {
  return module.slice(0, module.indexOf("/"));
}

/** True when scripts/layers.json names the layer of `module`. */
export function hasLayer(module) {
  return layerRank.has(layerOf(module));
}

/** Sorts modules: the layers bottom-up, the foundation in its order, then by name. */
export function compareModules(a, b) {
  return (
    layerRank.get(layerOf(a)) - layerRank.get(layerOf(b)) ||
    (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0) ||
    (a < b ? -1 : 1)
  );
}

/**
 * The kind of a crossing from one module to another, or null: "upward" to a
 * higher layer, "areas" between two areas, "order" against foundationOrder.
 * `missingOrder` gets a foundation module that foundationOrder lacks.
 */
export function crossingKind(from, to, missingOrder = () => {}) {
  if (from === to) return null;
  const fromLayer = layerOf(from);
  const toLayer = layerOf(to);
  if (layerRank.get(fromLayer) < layerRank.get(toLayer)) return "upward";
  if (fromLayer === "areas" && toLayer === "areas") return "areas";
  if (fromLayer === "foundation" && toLayer === "foundation") {
    const a = orderRank.get(from);
    const b = orderRank.get(to);
    if (a === undefined || b === undefined) {
      missingOrder(a === undefined ? from : to);
      return null;
    }
    return a < b ? "order" : null;
  }
  return null;
}

/** The public source files and folders of the areas. */
export const publicPaths = (targets.contracts ?? []).filter(
  (path) => targets.packages[path] === undefined,
);
export function isPublic(path) {
  return publicPaths.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

/** A count of links for each file: file -> { module: count }. */
export function linkCounter() {
  const links = new Map();
  return {
    links,
    link(path, module) {
      const entry = links.get(path) ?? {};
      entry[module] = (entry[module] ?? 0) + 1;
      links.set(path, entry);
    },
  };
}

/** The keys with no written reason or no written fix in `reasons`. */
export function keysWithoutReason(keys, reasons) {
  return keys.filter(
    (key) =>
      typeof reasons[key]?.reason !== "string" ||
      reasons[key].reason.trim() === "" ||
      typeof reasons[key]?.fix !== "string" ||
      reasons[key].fix.trim() === "",
  );
}

export function trackedFiles(...paths) {
  return execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((path) => path !== "");
}

/** The tracked TypeScript source files that scripts/layers.json covers. */
export function coveredSourceFiles() {
  return trackedFiles(...targets.covers).filter(
    (path) =>
      /\.(ts|tsx)$/.test(path) &&
      !path.endsWith(".d.ts") &&
      !/\/generated\//.test(path) &&
      existsSync(join(root, path)),
  );
}

const IMPORT =
  /(?:import|export)(\s+type)?\s[^'";]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * The imports of a source text, static and dynamic. `typeOnly` is true for
 * `import type … from` and `export type … from`, which leave no import in
 * the built code.
 */
export function importStatementsOf(text) {
  return [...text.matchAll(IMPORT)].map((match) => ({
    specifier: match[2] ?? match[3],
    typeOnly: match[1] !== undefined,
  }));
}

/** The import specifiers of a source text, static and dynamic. */
export function importsOf(text) {
  return importStatementsOf(text).map(({ specifier }) => specifier);
}

/** A resolver of relative imports against a set of known files. */
export function relativeResolver(known) {
  return (from, specifier) => {
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
  };
}
