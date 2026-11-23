#!/usr/bin/env node
// Prints the bundle size of each Worker (Refactor 17, step A0.4).
//
// Each Worker is built with `wrangler deploy --dry-run` into a temporary
// folder. Nothing is uploaded, and no sign-in is needed. The size is the sum
// of the modules that an upload sends: no source map and no README.
//
// The Workers need these generated files first:
//   pnpm --filter @purin-labs/async-control build
//   pnpm --filter @purin-labs/platform contracts:media
//   pnpm --filter @purin-labs/platform vault-onepassword:prepare
//
//   node scripts/worker-bundle-sizes.mjs            every Worker
//   node scripts/worker-bundle-sizes.mjs platform   one Worker
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { isUploadedModule } from "./lib/side-worker.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const WORKERS = [
  { name: "platform", folder: "workers/platform" },
  {
    name: "slack-ingress",
    folder: "workers/platform",
    config: "wrangler.slack-ingress.jsonc",
  },
  {
    name: "model-exit",
    folder: "workers/platform",
    config: "wrangler.model-exit.jsonc",
  },
  {
    name: "chatgpt-exit",
    folder: "workers/platform",
    config: "wrangler.chatgpt-exit.jsonc",
  },
  {
    name: "code-mode-sandbox",
    folder: "workers/platform",
    config: "wrangler.code-mode-sandbox.jsonc",
  },
  {
    name: "vault-onepassword",
    folder: "workers/platform",
    config: "wrangler.vault-onepassword.jsonc",
  },
  { name: "commerce", folder: "services/commerce" },
];

function filesUnder(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(folder, entry.name))
      : [join(folder, entry.name)],
  );
}

const wanted = process.argv.slice(2);
let failed = false;
console.log("    bytes     gzip  modules  Worker");
for (const worker of WORKERS) {
  if (wanted.length > 0 && !wanted.includes(worker.name)) continue;
  const out = mkdtempSync(join(tmpdir(), `pantry-bundle-${worker.name}-`));
  try {
    const run = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--env",
        "production",
        "--experimental-provision=false",
        ...(worker.config === undefined ? [] : ["--config", worker.config]),
        "--dry-run",
        "--outdir",
        out,
      ],
      {
        cwd: join(root, worker.folder),
        encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
      },
    );
    if (run.status !== 0) {
      failed = true;
      console.error(`${worker.name}: the dry run failed`);
      console.error(
        (run.stdout + run.stderr).split("\n").slice(-12).join("\n"),
      );
      continue;
    }
    const modules = filesUnder(out).filter((path) =>
      isUploadedModule(path.slice(path.lastIndexOf("/") + 1)),
    );
    let bytes = 0;
    let gzip = 0;
    for (const path of modules) {
      const content = readFileSync(path);
      bytes += content.length;
      gzip += gzipSync(content).length;
    }
    console.log(
      `${String(bytes).padStart(9)} ${String(gzip).padStart(8)} ${String(modules.length).padStart(8)}  ${worker.name}`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
