#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { upsertLocalEnv } from "../slack/local-env.mjs";
import {
  readSlackIngressEnvironment,
  readWorkerEnvironment,
} from "../worker-environment.mjs";

const SUPPORTED_SECRETS = new Set([
  "COMMERCE_LAB_SIGNING_SECRET",
  "GDRIVE_OAUTH_CLIENT_ID",
  "GDRIVE_OAUTH_CLIENT_SECRET",
  "GDRIVE_PICKER_API_KEY",
  "GDRIVE_PICKER_APP_ID",
  "OPENROUTER_API_KEY",
  "PANTRY_FAULT_INJECTION_TOKEN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "STRIPE_CONNECT_CLIENT_ID",
  "STRIPE_CONNECT_CLIENT_SECRET",
  "STRIPE_CONNECT_WEBHOOK_ID",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "ORGANISATION_ADMIN_TOKEN",
]);

// The Slack ingress Worker holds one secret: a copy of the signing secret of
// the platform Worker. The copy is never generated.
const SLACK_INGRESS_SECRETS = new Set(["SLACK_SIGNING_SECRET"]);

const WORKERS = new Map([
  [
    "platform",
    {
      label: "the Satyr Worker",
      config: "services/platform/wrangler.jsonc",
      secrets: SUPPORTED_SECRETS,
      mayGenerate: true,
      read: readWorkerEnvironment.bind(null, "platform"),
    },
  ],
  [
    "slack-ingress",
    {
      label: "the Slack ingress Worker",
      config: "services/platform/wrangler.slack-ingress.jsonc",
      secrets: SLACK_INGRESS_SECRETS,
      mayGenerate: false,
      read: readSlackIngressEnvironment,
    },
  ],
]);

const LOCAL_ENV_NAMES = new Map([
  ["COMMERCE_LAB_SIGNING_SECRET", "PANTRY_COMMERCE_LAB_SIGNING_SECRET"],
]);

async function main() {
  const secretName = process.argv[2]?.trim() ?? "";
  const generate = process.argv.includes("--generate");
  const environment = process.argv[process.argv.indexOf("--env") + 1];
  if (!process.argv.includes("--env") || environment !== "production")
    throw new Error(
      "Secret upload requires --env production; staging is unavailable",
    );
  const workerName = process.argv.includes("--worker")
    ? process.argv[process.argv.indexOf("--worker") + 1]
    : "platform";
  const worker = WORKERS.get(workerName);
  if (worker === undefined) throw new Error(`Unknown Worker: ${workerName}`);
  worker.read(environment);

  if (!worker.secrets.has(secretName)) {
    throw new Error(`Unsupported Worker secret: ${secretName || "missing"}`);
  }
  if (generate && !worker.mayGenerate)
    throw new Error(`${secretName} of ${worker.label} is never generated`);

  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const envPath = resolve(repositoryRoot, ".env.local");
  const secretValue = await resolveSecretValue(secretName, generate, envPath);
  const wrangler = resolve(
    repositoryRoot,
    "services/platform/node_modules/.bin/wrangler",
  );
  const config = resolve(repositoryRoot, worker.config);
  const result = spawnSync(
    wrangler,
    ["secret", "put", secretName, "--config", config, "--env", environment],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: "/tmp/satyr-wrangler-secret.log",
      },
      input: `${secretValue}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  assertChildResult(result);
  console.log(`Synchronized ${secretName} from .env.local to ${worker.label}.`);
}

async function resolveSecretValue(secretName, generate, envPath) {
  const localEnvName = LOCAL_ENV_NAMES.get(secretName) ?? secretName;
  const configured = process.env[localEnvName]?.trim() ?? "";

  if (configured.length > 0) return configured;

  if (!generate) {
    throw new Error(`${localEnvName} is required in .env.local`);
  }

  const generated = randomBytes(32).toString("hex");
  await upsertLocalEnv(envPath, { [localEnvName]: generated });
  process.env[localEnvName] = generated;
  console.log(`Generated and saved ${localEnvName} in .env.local.`);
  return generated;
}

function assertChildResult(result) {
  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) {
    throw new Error(
      `Wrangler secret synchronization failed with status ${result.status}`,
    );
  }
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

await main().catch(handleFatalError);
