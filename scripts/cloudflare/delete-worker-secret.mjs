#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { removeLocalEnvValues } from "../slack/local-env.mjs";
import { readWorkerEnvironment } from "../worker-environment.mjs";

const DELETABLE_SECRETS = new Set(["PANTRY_FAULT_INJECTION_TOKEN"]);

async function main() {
  const secretName = process.argv[2]?.trim() ?? "";
  const environment = process.argv[process.argv.indexOf("--env") + 1];
  if (!process.argv.includes("--env") || environment !== "production")
    throw new Error(
      "Secret deletion requires --env production; staging is unavailable",
    );
  readWorkerEnvironment("platform", environment);

  if (!DELETABLE_SECRETS.has(secretName)) {
    throw new Error(
      `Unsupported temporary Worker secret: ${secretName || "missing"}`,
    );
  }

  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const envPath = resolve(repositoryRoot, ".env.local");
  const wrangler = resolve(
    repositoryRoot,
    "workers/platform/node_modules/.bin/wrangler",
  );
  const config = resolve(repositoryRoot, "workers/platform/wrangler.jsonc");
  const result = spawnSync(
    wrangler,
    ["secret", "delete", secretName, "--config", config, "--env", environment],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: "/tmp/pantry-wrangler-secret.log",
      },
      input: "y\n",
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  assertChildResult(result);
  await removeLocalEnvValues(envPath, [secretName]);
  console.log(`Deleted ${secretName} from the Pantry Worker and .env.local.`);
}

function assertChildResult(result) {
  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) {
    throw new Error(
      `Wrangler secret deletion failed with status ${result.status}`,
    );
  }
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

await main().catch(handleFatalError);
