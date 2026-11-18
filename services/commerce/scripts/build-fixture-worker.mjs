#!/usr/bin/env node
// Builds the fixture Worker (tests/fixture-worker/worker.ts) into an artifact
// that client suites run with Miniflare: `<outdir>/worker.js` plus the module
// files it imports. Usage: node scripts/build-fixture-worker.mjs <outdir>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const service = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(process.argv[2] ?? join(service, ".fixture-worker"));
const wrangler = readFileSync(join(service, "wrangler.jsonc"), "utf8");
const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/u.exec(wrangler)?.[1];
if (compatibilityDate === undefined) throw new Error("wrangler.jsonc has no compatibility_date");

const scratch = mkdtempSync(join(tmpdir(), "underclerk-fixture-worker-"));
try {
  const config = join(scratch, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "underclerk-fixture",
      main: join(service, "tests/fixture-worker/worker.ts"),
      compatibility_date: compatibilityDate,
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  rmSync(outdir, { recursive: true, force: true });
  const result = spawnSync(
    join(service, "node_modules/.bin/wrangler"),
    ["deploy", "--dry-run", "--config", config, "--outdir", outdir],
    { cwd: service, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    process.exit(result.status ?? 1);
  }
  writeFileSync(join(outdir, "fixture-worker.json"), `${JSON.stringify({ compatibilityDate, compatibilityFlags: ["nodejs_compat"] })}\n`);
  console.log(`fixture Worker: ${join(outdir, "worker.js")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
