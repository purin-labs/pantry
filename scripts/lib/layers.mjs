// Shared by scripts/check-layers.mjs and scripts/list-tests.mjs: the module of
// a file from scripts/layers.json, and the imports of a source file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

export function trackedFiles(...paths) {
  return execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((path) => path !== "");
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
