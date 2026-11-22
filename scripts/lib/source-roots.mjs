// The folders that hold product source (Refactor 17, Stage B).
//
// A lint that finds its files by a root folder reads these lists, so a new
// root folder is one line here and not one line in each lint.
// scripts/refactor-17/move-module.mjs adds the root of a module that it moves.
// The JSON configs cannot import this file: .jscpd.json, knip.json and the
// lint commands of package.json name their folders themselves.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The top-level folders that hold product source. */
export const SOURCE_ROOTS = ["apps", "foundation", "packages", "services"];

/** The folders that hold the source of the Platform Worker. */
export const PLATFORM_SOURCE = ["services/platform/src", "foundation"];

const SKIPPED = new Set(["node_modules", "dist", ".wrangler", "target"]);

function filesUnder(directory, test) {
  const found = [];
  for (const name of readdirSync(directory)) {
    if (SKIPPED.has(name) || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, test));
    else if (test(name)) found.push(path);
  }
  return found;
}

/**
 * Each file under `folders` of the repository `root` whose name passes
 * `test`, as an absolute path. Build output, dependencies and dot folders are
 * not read.
 */
export function filesIn(root, folders, test) {
  return folders.flatMap((folder) => filesUnder(join(root, folder), test));
}
