#!/usr/bin/env node
// Fails when a Portal file adds a raw fetch (Refactor 10, step 4.5).
//
// A Portal feature reads the control API through `controlRead` and changes it
// through `controlMutation`, `controlUpload` or `controlSecretMutation`
// (foundation/control/portal/control-client.ts). The baseline in
// scripts/portal-fetch-ratchet.json lists each file that still calls `fetch`
// itself, with its count. A listed file may not add a call, and a new file may
// not call `fetch`. When a file loses a call, lower its entry with --update.
// The files in NOT_CONTROL fetch something that is not the control API.
//
//   node scripts/check-portal-fetch-ratchet.mjs            check
//   node scripts/check-portal-fetch-ratchet.mjs --update   lower entries, drop files with no call
//   node scripts/check-portal-fetch-ratchet.mjs --init     write the baseline from the current tree
import { runCountRatchet } from "./lib/count-ratchet.mjs";
import { inFolders, PORTAL_SOURCE } from "./lib/source-roots.mjs";

const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/;
const EXCLUDED = [
  /^apps\/portal\/src\/dev\//,
  /\.test\.[a-z]+$/,
  /^(apps\/portal\/src|foundation\/control\/portal)\/control-client\.ts$/,
];
// Files that fetch assets, models, bundles or another origin, not the control API.
const NOT_CONTROL = new Set([
  "apps/portal/src/features/access/google-drive-picker.ts",
  "apps/portal/src/features/production-run/execution-client.ts",
  "apps/portal/src/features/production-run/execution-worker.ts",
  "apps/portal/src/features/production-run/retained-appliance-worker.ts",
  "apps/portal/src/features/voice/model-cache.ts",
  "apps/portal/src/features/workflow-simulator/rehearsal-examples.ts",
  "apps/portal/src/features/workflow-simulator/spatial/physics-asset-loader.ts",
  // The voice transport's other calls go to the shop Mac's own origin.
  "apps/portal/src/features/voice/transport.ts",
  // The identity link page calls /v1/identity-links, outside the control API.
  "apps/portal/src/main.tsx",
  // A paired screen reads the screens API with its own device credential.
  "apps/portal/src/tv/player.tsx",
]);
const CALL = /(?<![\w.$])fetch\s*\(/gu;

runCountRatchet({
  name: "portal fetch ratchet",
  script: "scripts/check-portal-fetch-ratchet.mjs",
  baseline: "scripts/portal-fetch-ratchet.json",
  count: (file, read) =>
    inFolders(file, PORTAL_SOURCE) &&
    SOURCE.test(file) &&
    !EXCLUDED.some((pattern) => pattern.test(file)) &&
    !NOT_CONTROL.has(file)
      ? (read().match(CALL)?.length ?? 0)
      : 0,
  refusal: (file, calls, allowed) =>
    `${file} has ${calls} raw fetch calls, ${allowed} allowed. Read the control API with controlRead and change it with controlMutation (foundation/control/portal/control-client.ts).`,
});
