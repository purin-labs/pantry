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
export const SOURCE_ROOTS = [
  "apps",
  "areas",
  "foundation",
  "packages",
  "services",
];

/** The folders that hold the source of the Platform Worker. */
export const PLATFORM_SOURCE = ["services/platform/src", "foundation"];
// The Worker side of packages/collaboration (Refactor 17, Stage B).
PLATFORM_SOURCE.push("packages/collaboration/worker");
// The Worker side of the area devices (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/devices/server");
// The Worker side of the area brain (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/brain/server");

/**
 * The folders that hold the source of the Portal, in the browser. The package
 * foundation/ui and the Portal files of foundation/control leave
 * apps/portal/src with their moves (Refactor 17, Stage B); the control move
 * adds its folder here.
 */
export const PORTAL_SOURCE = [
  "apps/portal/src",
  "foundation/control/portal",
  "foundation/ui",
];
// The Portal side of packages/collaboration (Refactor 17, Stage B).
PORTAL_SOURCE.push("packages/collaboration/portal");
// The Portal side of the area devices (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/devices/ui");
// The Portal side of the area brain (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/brain/ui");

/** True when a repository path is in one of `folders`. */
export function inFolders(path, folders) {
  return folders.some((folder) => path.startsWith(`${folder}/`));
}

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
