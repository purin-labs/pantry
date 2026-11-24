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
  "surfaces",
  "workers",
];

/** The folders that hold the source of the Platform Worker. */
export const PLATFORM_SOURCE = ["workers/platform/src", "foundation"];
// The Worker side of packages/collaboration (Refactor 17, Stage B).
PLATFORM_SOURCE.push("packages/collaboration/worker");
// The Worker side of the area devices (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/devices/server");
// The Worker side of the area brain (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/brain/server");
// The Worker side of the area organisation (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/organisation/server");
// The Worker side of the area cafe (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/cafe/server");
// The Worker side of the area inbox (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/inbox/server");
// The Worker side of the area integrations (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/integrations/server");
// The Worker side of the area commerce (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/commerce/server");
// The Worker side of the area kitchen (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/kitchen/server");
// The Worker side of the surface whatsapp (Refactor 17, Stage B).
PLATFORM_SOURCE.push("surfaces/whatsapp/server");
// The Worker side of the surface email (Refactor 17, Stage B).
PLATFORM_SOURCE.push("surfaces/email/server");
// The Shopify module in the package of the area integrations (Refactor 17,
// Stage B).
PLATFORM_SOURCE.push("areas/integrations/shopify");
// The Worker side of the surface slack (Refactor 17, Stage B).
PLATFORM_SOURCE.push("surfaces/slack/server");
// The Worker side of the surface webhooks (Refactor 17, Stage B).
PLATFORM_SOURCE.push("surfaces/webhooks/server");
// The Worker side of the surface voice (Refactor 17, Stage B).
PLATFORM_SOURCE.push("surfaces/voice/server");
// The Worker side of the surface portal (Refactor 17, Stage B).
PLATFORM_SOURCE.push("surfaces/portal/server");
// The Worker side of the contract of the area commerce (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/commerce/contract/server");
// The Worker side of the contract of the area inbox (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/inbox/contract/server");
// The Worker side of the contract of the area devices (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/devices/contract/server");
// The Worker side of the contract of the area kitchen (Refactor 17, Stage B).
PLATFORM_SOURCE.push("areas/kitchen/contract/server");

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
// The Portal side of the area organisation (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/organisation/ui");
// The Portal side of the area cafe (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/cafe/ui");
// The Portal side of the area inbox (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/inbox/ui");
// The Portal side of the area integrations (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/integrations/ui");
// The Portal side of the area commerce (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/commerce/ui");
// The Portal side of the area kitchen (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/kitchen/ui");
// The Portal side of the surface voice (Refactor 17, Stage B).
PORTAL_SOURCE.push("surfaces/voice/ui");
// The Portal side of the surface portal (Refactor 17, Stage B).
PORTAL_SOURCE.push("surfaces/portal/ui");
// The Portal side of the contract of the area commerce (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/commerce/contract/ui");
// The Portal side of the contract of the area inbox (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/inbox/contract/ui");
// The Portal side of the contract of the area kitchen (Refactor 17, Stage B).
PORTAL_SOURCE.push("areas/kitchen/contract/ui");

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
