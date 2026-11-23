#!/usr/bin/env node
// The release guard (Plan 93) for a Worker that deploys with plain
// `wrangler deploy`: the docs site and the shop. It refuses a Wrangler
// profile whose Worker is not a Pantry Worker, or that has a workers.dev
// address, a preview address or a route other than its custom domain.
//
//   node scripts/check-release-target.mjs <wrangler file> [environment]
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { requireReleaseTarget } from "./worker-environment.mjs";

const [file, environment] = process.argv.slice(2);
if (file === undefined)
  throw new Error("Name the Wrangler file of the Worker to deploy");
const root = resolve(import.meta.dirname, "..");
const { unstable_readConfig } = createRequire(
  resolve(root, "workers/platform/package.json"),
)("wrangler");
const config = unstable_readConfig({
  config: resolve(process.cwd(), file),
  ...(environment === undefined ? {} : { env: environment }),
});
requireReleaseTarget(config);
console.log(`release guard: ${config.name} may deploy`);
