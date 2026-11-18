#!/usr/bin/env node
// Fails when a Portal file adds a raw fetch (Refactor 10, step 4.5).
//
// A Portal feature reads the control API through `controlRead` and changes it
// through `controlMutation`, `controlUpload` or `controlSecretMutation`
// (apps/portal/src/control-client.ts). The baseline in
// scripts/portal-fetch-ratchet.json lists each file that still calls `fetch`
// itself, with its count. A listed file may not add a call, and a new file may
// not call `fetch`. When a file loses a call, lower its entry with --update.
// The files in NOT_CONTROL fetch something that is not the control API.
//
//   node scripts/check-portal-fetch-ratchet.mjs            check
//   node scripts/check-portal-fetch-ratchet.mjs --update   lower entries, drop files with no call
//   node scripts/check-portal-fetch-ratchet.mjs --init     write the baseline from the current tree
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "scripts/portal-fetch-ratchet.json";
const SOURCE = /^apps\/portal\/src\/.+\.(ts|tsx|mjs|js|jsx)$/;
const EXCLUDED = [
  /^apps\/portal\/src\/dev\//,
  /\.test\.[a-z]+$/,
  /^apps\/portal\/src\/control-client\.ts$/,
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

const mode = process.argv[2] ?? "check";
if (!["check", "--update", "--init"].includes(mode)) {
  console.error(`unknown argument ${mode}`);
  process.exit(2);
}
const current = new Map();
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(
    (file) =>
      SOURCE.test(file) &&
      !EXCLUDED.some((pattern) => pattern.test(file)) &&
      !NOT_CONTROL.has(file),
  );
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  const calls = text.match(CALL)?.length ?? 0;
  if (calls > 0) current.set(file, calls);
}

function write(entries) {
  const sorted = Object.fromEntries(
    [...entries].sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    join(root, BASELINE),
    `${JSON.stringify({ files: sorted }, null, 2)}\n`,
  );
}
if (mode === "--init") {
  write(current);
  const total = [...current.values()].reduce((sum, n) => sum + n, 0);
  console.log(
    `portal fetch ratchet: wrote ${current.size} files with ${total} raw fetch calls to ${BASELINE}`,
  );
  process.exit(0);
}
const baseline = new Map(
  Object.entries(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).files),
);
const errors = [];
const lower = [];
for (const [file, calls] of current) {
  const allowed = baseline.get(file) ?? 0;
  if (calls > allowed)
    errors.push(
      `${file} has ${calls} raw fetch calls, ${allowed} allowed. Read the control API with controlRead and change it with controlMutation (apps/portal/src/control-client.ts).`,
    );
  else if (calls < allowed) lower.push(file);
}
for (const file of baseline.keys()) if (!current.has(file)) lower.push(file);
if (mode === "--update") {
  const next = new Map(
    [...baseline]
      .map(([file, allowed]) => [
        file,
        Math.min(allowed, current.get(file) ?? 0),
      ])
      .filter(([, n]) => n > 0),
  );
  write(next);
  console.log(`portal fetch ratchet: ${next.size} files remain`);
} else if (lower.length > 0)
  console.log(
    `portal fetch ratchet: ${lower.length} files have fewer calls; run node scripts/check-portal-fetch-ratchet.mjs --update`,
  );
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
