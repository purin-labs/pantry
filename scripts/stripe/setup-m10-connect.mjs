#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { promptForHiddenTerminalValue } from "../slack/ensure-app-config-token.mjs";
import { upsertLocalEnv } from "../slack/local-env.mjs";

const CLIENT_ID_NAME = "STRIPE_CONNECT_CLIENT_ID";
const CLIENT_SECRET_NAME = "STRIPE_CONNECT_CLIENT_SECRET";

async function main() {
  const clientId = await promptForHiddenTerminalValue(
    process.stdin,
    process.stderr,
    "Paste the Stripe Connect client ID (ca_..., input hidden): ",
  );
  const clientSecret = await promptForHiddenTerminalValue(
    process.stdin,
    process.stderr,
    "Paste the Stripe test-mode platform secret key (sk_test_..., input hidden): ",
  );
  assertStripeConnectCredentials(clientId, clientSecret);

  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const envPath = resolve(repositoryRoot, ".env.local");
  await upsertLocalEnv(envPath, {
    [CLIENT_ID_NAME]: clientId,
    [CLIENT_SECRET_NAME]: clientSecret,
  });
  syncWorkerSecret(repositoryRoot, CLIENT_ID_NAME, clientId);
  syncWorkerSecret(repositoryRoot, CLIENT_SECRET_NAME, clientSecret);
  console.log("Saved and uploaded Stripe Connect OAuth configuration.");
}

export function assertStripeConnectCredentials(clientId, clientSecret) {
  if (!/^ca_[A-Za-z0-9]{8,}$/u.test(clientId)) {
    throw new Error("The Stripe Connect client ID must start with ca_");
  }
  if (!/^sk_test_[A-Za-z0-9]{16,}$/u.test(clientSecret)) {
    throw new Error(
      "The Stripe platform secret must be a test-mode sk_test_ key",
    );
  }
}

export function syncWorkerSecret(repositoryRoot, name, value) {
  const script = resolve(
    repositoryRoot,
    "scripts/cloudflare/sync-worker-secret.mjs",
  );
  const result = spawnSync(process.execPath, [script, name], {
    cwd: repositoryRoot,
    env: { ...process.env, [name]: value },
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Failed to upload ${name}`);
  }
}

function handleFatalError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function isMainModule(moduleUrl, entryPath) {
  return (
    typeof entryPath === "string" &&
    fileURLToPath(moduleUrl) === resolve(entryPath)
  );
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(handleFatalError);
}
